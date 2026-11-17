import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConcurrencyConflictException } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SqliteSettlementBookRepository } from '@Contexts/Settlements/Infrastructure/Repositories/SqliteSettlementBookRepository';
import { SettlementBook, SettlementRequest } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/**
 * The provider's webhook reads its payment's book from the file and saves it, so a webhook that arrives after Tally was stopped
 * and started again, or at the same moment as another, meets the book as the file holds it (request 14, the storm
 * `webhooks-late-twice-out-of-order`). These tests hold the store to that on a real file.
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

/** A group's book with one settlement through the provider, kept pending under the payment id `pay_1`. */
function bookWithPendingPayment(): SettlementBook {
  const book = SettlementBook.open('group-1');
  const proposal = book.proposePayment(REQUEST);
  if (proposal.isFailure()) throw new Error('the payment should be decided');
  const kept = book.keepPayment(proposal.data, { id: 'pay_1', payUrl: 'https://provider.example/pay/pay_1' });
  if (kept.isFailure()) throw new Error('the payment should be kept');
  return book;
}

const succeeded = { paymentId: 'pay_1', status: 'succeeded' };

describe('SqliteSettlementBookRepository, webhooks late and at once (request 14)', () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tally-settlement-books-'));
    file = join(directory, 'tally.db');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps a payment the provider says succeeded after Tally was stopped and started again, and counts it once', async () => {
    const before = new SqliteDatabase(file);
    await new SqliteSettlementBookRepository(before).save(bookWithPendingPayment());
    before.connection.close();

    // Tally is started again on the same file: the webhook finds the book as it was saved.
    const after = new SqliteDatabase(file);
    const books = new SqliteSettlementBookRepository(after);
    const found = await books.findByPaymentId('pay_1');
    if (!found) throw new Error('the book should be in the file');
    expect(found.receiveProviderUpdate(succeeded).isSuccess()).toBe(true);
    expect((await books.save(found)).isSuccess()).toBe(true);
    after.connection.close();

    // Stopped and started a second time, the next webhook of the same payment changes nothing.
    const again = new SqliteDatabase(file);
    const reread = await new SqliteSettlementBookRepository(again).findByPaymentId('pay_1');
    if (!reread) throw new Error('the book should be in the file');
    expect(reread.toSnapshot().changed).toEqual([]);
    reread.receiveProviderUpdate(succeeded);
    expect(reread.hasChanges()).toBe(false);
    again.connection.close();
  });

  it('refuses the second of two writers who read the book at once, and the book then holds the payment paid once', async () => {
    const database = new SqliteDatabase(file);
    const books = new SqliteSettlementBookRepository(database);
    await books.save(bookWithPendingPayment());

    // Two servers receive the same webhook: both read the book at the version it is at, and both decide it paid.
    const first = await books.findByPaymentId('pay_1');
    const second = await books.findByPaymentId('pay_1');
    if (!first || !second) throw new Error('the book should be in the file');
    first.receiveProviderUpdate(succeeded);
    second.receiveProviderUpdate(succeeded);

    expect((await books.save(first)).isSuccess()).toBe(true);
    const refused = await books.save(second);
    expect(refused.isFailure() && refused.error).toBeInstanceOf(ConcurrencyConflictException);

    // The command re-reads the book, finds the payment paid, and records nothing: the payment is counted once.
    const reread = await books.findByPaymentId('pay_1');
    if (!reread) throw new Error('the book should be in the file');
    reread.receiveProviderUpdate(succeeded);
    expect(reread.hasChanges()).toBe(false);
    expect(reread.toSnapshot().changed).toEqual([]);
    database.connection.close();
  });
});
