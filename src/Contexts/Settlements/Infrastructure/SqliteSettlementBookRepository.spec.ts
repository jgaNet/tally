import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Id } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { SqliteSettlementBookRepository } from '@Contexts/Settlements/Infrastructure/SqliteSettlementBookRepository';

const at = new Date('2026-11-01T10:00:00.000Z');
const payer = new Id('payer');
const payee = new Id('payee');
const members = ['payer', 'payee'];
const balances = new Map([
  ['payer', -30],
  ['payee', 30],
]);

/** A database file that is opened, closed and opened again, as Tally is stopped and started. */
let directory: string;
let file: string;
const opened: SqliteDatabase[] = [];

function start(): { database: SqliteDatabase; repository: SqliteSettlementBookRepository } {
  const database = new SqliteDatabase(file);
  opened.push(database);
  return { database, repository: new SqliteSettlementBookRepository(database) };
}

function stop(database: SqliteDatabase) {
  database.connection.close();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tally-webhooks-'));
  file = join(directory, 'tally.sqlite');
});

afterEach(() => {
  for (const database of opened.splice(0)) {
    try {
      database.connection.close();
    } catch {
      // already closed by the test
    }
  }
  rmSync(directory, { recursive: true, force: true });
});

describe('SqliteSettlementBookRepository: a webhook that is late, or at the same moment, counts a payment once', () => {
  it('finds a payment still pending after Tally was stopped and started, and counts it once the provider says it succeeded', async () => {
    const groupId = Id.generate();
    const first = start();
    const book = SettlementBook.open(groupId, 0);
    const proposal = book.proposePayment({ payer, payee, amount: 30, balances, members });
    if (proposal.isFailure()) throw new Error('refused');
    book.keepPayment(proposal.data, { id: 'late-pay', payUrl: 'https://pay.example/late-pay' }, at);
    expect((await first.repository.save(book)).isSuccess()).toBe(true);
    stop(first.database);

    const second = start();
    const late = await second.repository.findByPaymentId('late-pay');
    expect(late).not.toBeNull();
    late!.receivePayment({ paymentId: 'late-pay', status: 'succeeded' });
    expect(late!.unsaved).toHaveLength(1);
    expect(late!.unsaved[0].status).toBe('paid');
    expect((await second.repository.save(late!)).isSuccess()).toBe(true);
    stop(second.database);

    const third = start();
    const after = await third.repository.findByPaymentId('late-pay');
    after!.receivePayment({ paymentId: 'late-pay', status: 'pending' });
    after!.receivePayment({ paymentId: 'late-pay', status: 'failed' });
    expect(after!.unsaved).toHaveLength(0);
  });

  it('refuses the second of two books read at the same version, which re-reads a payment the first already paid', async () => {
    const groupId = Id.generate();
    const setup = start();
    const book = SettlementBook.open(groupId, 0);
    const proposal = book.proposePayment({ payer, payee, amount: 30, balances, members });
    if (proposal.isFailure()) throw new Error('refused');
    book.keepPayment(proposal.data, { id: 'shared-pay', payUrl: 'https://pay.example/shared-pay' }, at);
    await setup.repository.save(book);

    // Two servers on the same file read the same book, and both hear the same webhook.
    const server = start();
    const other = start();
    const firstReading = await server.repository.findByPaymentId('shared-pay');
    const secondReading = await other.repository.findByPaymentId('shared-pay');
    firstReading!.receivePayment({ paymentId: 'shared-pay', status: 'succeeded' });
    secondReading!.receivePayment({ paymentId: 'shared-pay', status: 'succeeded' });

    expect((await server.repository.save(firstReading!)).isSuccess()).toBe(true);
    const conflict = await other.repository.save(secondReading!);
    expect(conflict.isFailure()).toBe(true);
    expect((conflict.error as { type?: string }).type).toBe('ConcurrencyConflict');

    // The second server re-reads in a new transaction: the payment is paid already, so it records nothing.
    const reread = await other.repository.findByPaymentId('shared-pay');
    reread!.receivePayment({ paymentId: 'shared-pay', status: 'succeeded' });
    expect(reread!.unsaved).toHaveLength(0);
  });
});
