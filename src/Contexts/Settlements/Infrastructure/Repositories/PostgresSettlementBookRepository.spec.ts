import { ConcurrencyConflictException } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { PostgresSettlementBookRepository } from '@Contexts/Settlements/Infrastructure/Repositories/PostgresSettlementBookRepository';
import { SettlementBook, SettlementRequest } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/**
 * The provider's webhook reads its payment's book from the database and saves it, so a webhook that arrives after Tally was stopped
 * and started again, or at the same moment as another, meets the book as the database holds it (request 14, the storm
 * `webhooks-late-twice-out-of-order`). These tests hold the store to that on a real database.
 */
const AT = new Date('2026-11-17T10:00:00.000Z');
const REQUEST: SettlementRequest = {
  payer: 'bob',
  payee: 'ann',
  amount: 30,
  at: AT,
  members: ['ann', 'bob'],
  balances: [
    { memberId: 'ann', balance: 30 },
    { memberId: 'bob', balance: -30 },
  ],
};

/** A group's book with one settlement through the provider, kept pending under the payment id `paymentId`. */
function bookWithPendingPayment(groupId: string, paymentId: string): SettlementBook {
  const book = SettlementBook.open(groupId);
  const proposal = book.proposePayment(REQUEST, 'acct_ann');
  if (proposal.isFailure()) throw new Error('the payment should be decided');
  const kept = book.keepPayment(proposal.data, {
    id: paymentId,
    payUrl: `https://provider.example/pay/${paymentId}`,
    fee: 0,
  });
  if (kept.isFailure()) throw new Error('the payment should be kept');
  return book;
}

const succeeded = { paymentId: 'pay_1', status: 'succeeded' };
const succeededTwice = { paymentId: 'pay_2', status: 'succeeded' };

describe('PostgresSettlementBookRepository, webhooks late and at once (request 14)', () => {
  const databases: PostgresDatabase[] = [];

  /** A server on the application's database: its repository is built first (it declares its tables), then the database is opened. */
  async function startServer(): Promise<PostgresSettlementBookRepository> {
    const database = new PostgresDatabase(process.env.DATABASE_URL!);
    databases.push(database);
    const repository = new PostgresSettlementBookRepository(database);
    await database.open();
    return repository;
  }

  afterAll(async () => {
    for (const database of databases) await database.close();
  });

  it('keeps a payment the provider says succeeded after Tally was stopped and started again, and counts it once', async () => {
    const before = await startServer();
    await before.save(bookWithPendingPayment('group-1', 'pay_1'));

    // Tally is started again on the same database: the webhook finds the book as it was saved.
    const books = await startServer();
    const found = await books.findByPaymentId('pay_1');
    if (!found) throw new Error('the book should be in the database');
    expect(found.receiveProviderUpdate(succeeded, AT).isSuccess()).toBe(true);
    expect((await books.save(found)).isSuccess()).toBe(true);

    // Stopped and started a second time, the next webhook of the same payment changes nothing.
    const reread = await (await startServer()).findByPaymentId('pay_1');
    if (!reread) throw new Error('the book should be in the database');
    expect(reread.toSnapshot().changed).toEqual([]);
    reread.receiveProviderUpdate(succeeded, AT);
    expect(reread.hasChanges()).toBe(false);
  });

  it('refuses the second of two writers who read the book at once, and the book then holds the payment paid once', async () => {
    const books = await startServer();
    await books.save(bookWithPendingPayment('group-2', 'pay_2'));

    // Two servers receive the same webhook: both read the book at the version it is at, and both decide it paid.
    const first = await books.findByPaymentId('pay_2');
    const second = await books.findByPaymentId('pay_2');
    if (!first || !second) throw new Error('the book should be in the database');
    first.receiveProviderUpdate(succeededTwice, AT);
    second.receiveProviderUpdate(succeededTwice, AT);

    expect((await books.save(first)).isSuccess()).toBe(true);
    const refused = await books.save(second);
    expect(refused.isFailure() && refused.error).toBeInstanceOf(ConcurrencyConflictException);

    // The command re-reads the book, finds the payment paid, and records nothing: the payment is counted once.
    const reread = await books.findByPaymentId('pay_2');
    if (!reread) throw new Error('the book should be in the database');
    reread.receiveProviderUpdate(succeededTwice, AT);
    expect(reread.hasChanges()).toBe(false);
    expect(reread.toSnapshot().changed).toEqual([]);
  });
});
