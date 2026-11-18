import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { ConcurrencyConflictException } from '@Architecture/Domain';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { InMemoryEventBus } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SqliteUnitOfWork } from '@Architecture/Infrastructure/Sqlite/SqliteUnitOfWork';

import { receivePaymentWebhook } from '@Contexts/Settlements/Application/Payments';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { SqliteSettlementBooks } from '@Contexts/Settlements/Infrastructure/SqliteSettlementBooks';

/**
 * Request 14 over a real SQLite file, with one connection per "server" or per run of Tally: a second connection on the same file is a
 * second server on the same database, and a connection opened after the first is closed is Tally started again (docs/adr/0002).
 */

const files: string[] = [];
const databases: SqliteDatabase[] = [];

const openFile = (path: string): SqliteDatabase => {
  const database = new SqliteDatabase(() => path);
  databases.push(database);
  return database;
};

const newFile = (): string => {
  const path = join(tmpdir(), `tally-settlement-books-${randomUUID()}.db`);
  files.push(path);
  return path;
};

afterAll(() => {
  // A run of Tally that was stopped in the test has its connection closed already.
  for (const database of databases) {
    try {
      database.connection.close();
    } catch {
      // already closed
    }
  }
  for (const path of files) for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
});

const GROUP = randomUUID();
const PAYER = randomUUID();
const PAYEE = randomUUID();
const SETTLEMENT = randomUUID();
const PAYMENT = `pay-${randomUUID()}`;

/** A settlement of 50 from the payer to the payee, pending on the provider's payment: what the first run of Tally recorded. */
async function recordPending(database: SqliteDatabase): Promise<void> {
  const book = SettlementBook.fromSnapshot({ groupId: GROUP, version: 0 });
  const recorded = book.recordProviderPayment(
    {
      archived: false,
      by: PAYER,
      to: PAYEE,
      amount: 50,
      members: [PAYER, PAYEE],
      balances: { payer: -50, payee: 50 },
      payoutAccount: PAYEE,
      at: new Date('2026-11-17T10:00:00Z'),
    },
    { settlementId: SETTLEMENT, providerPaymentId: PAYMENT, payUrl: `https://pay.example/${PAYMENT}` },
  );
  expect(recorded.isSuccess()).toBe(true);
  const unitOfWork = new SqliteUnitOfWork(database);
  await unitOfWork.beginTransaction();
  await new SqliteSettlementBooks(database).save(book);
  await unitOfWork.commitTransaction();
}

/** A webhook as one server of Tally receives it: the use case, run in its own transaction on the file. Its signature is not the subject here. */
async function receive(database: SqliteDatabase, { status }: { status: string }) {
  const context = new ExecutionContext({
    traceId: randomUUID(),
    eventBus: new InMemoryEventBus({ eventEmitter: new EventEmitter(), clock: systemClock }),
    unitOfWork: new SqliteUnitOfWork(database),
    auth: {},
  });
  return receivePaymentWebhook(new SqliteSettlementBooks(database), { isSignedBy: () => true }, systemClock).run(
    { body: randomUUID(), signature: 'signed', paymentId: PAYMENT, status },
    context,
  );
}

const statusOf = (database: SqliteDatabase): string =>
  (database.connection.prepare('SELECT status FROM settlements WHERE id = ?').get(SETTLEMENT) as { status: string })
    .status;

const versionOf = (database: SqliteDatabase): number =>
  Number(
    (
      database.connection.prepare('SELECT version FROM settlement_books WHERE group_id = ?').get(GROUP) as {
        version: number;
      }
    ).version,
  );

describe('webhooks on one database, late and at the same moment (request 14)', () => {
  it('settles a payment that the first run of Tally recorded, when a webhook arrives after Tally was stopped and started again', async () => {
    const path = newFile();
    const first = openFile(path);
    await recordPending(first);
    first.connection.close();

    const restarted = openFile(path);
    const result = await receive(restarted, { status: 'succeeded' });

    expect(result.isSuccess()).toBe(true);
    expect(statusOf(restarted)).toBe('paid');
  });

  it('records nothing when a second server receives a webhook the first already settled, and says it is acknowledged', async () => {
    const path = newFile();
    const first = openFile(path);
    await recordPending(first);
    const settled = await receive(first, { status: 'succeeded' });
    expect(settled.isSuccess()).toBe(true);
    expect(statusOf(first)).toBe('paid');
    expect(versionOf(first)).toBe(2);

    const second = openFile(path);
    const again = await receive(second, { status: 'succeeded' });

    expect(again.isSuccess()).toBe(true);
    expect(statusOf(second)).toBe('paid');
    expect(versionOf(second)).toBe(2);
  });

  it("refuses a save of a book read before another writer's save, so that the use case re-reads and decides again", async () => {
    const database = openFile(newFile());
    await recordPending(database);
    const books = new SqliteSettlementBooks(database);
    const unitOfWork = new SqliteUnitOfWork(database);

    await unitOfWork.beginTransaction();
    const first = await books.get(GROUP);
    const stale = await books.get(GROUP);
    first.settleProviderPayment({
      providerPaymentId: PAYMENT,
      status: 'succeeded',
      at: new Date('2026-11-17T10:00:00Z'),
    });
    expect((await books.save(first)).isSuccess()).toBe(true);

    stale.settleProviderPayment({
      providerPaymentId: PAYMENT,
      status: 'succeeded',
      at: new Date('2026-11-17T10:00:00Z'),
    });
    const refused = await books.save(stale);
    await unitOfWork.commitTransaction();

    expect(refused.isFailure()).toBe(true);
    expect(refused.isFailure() && refused.error).toBeInstanceOf(ConcurrencyConflictException);
    expect(statusOf(database)).toBe('paid');
    expect(versionOf(database)).toBe(2);
  });
});
