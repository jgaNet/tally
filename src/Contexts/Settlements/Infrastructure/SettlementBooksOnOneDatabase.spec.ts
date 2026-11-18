import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

import pg from 'pg';

import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { ConcurrencyConflictException } from '@Architecture/Domain';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { InMemoryEventBus } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PostgresUnitOfWork } from '@Architecture/Infrastructure/Postgres/PostgresUnitOfWork';

import { receivePaymentWebhook } from '@Contexts/Settlements/Application/Payments';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { PostgresSettlementBooks } from '@Contexts/Settlements/Infrastructure/PostgresSettlementBooks';

/**
 * A database of its own for this suite, named in DATABASE_URL's server (docs/adr/0029): created here, and its schema
 * made by the steps the stores and the outbox register, as the Bootstrap does at startup.
 */
let url = '';
async function createDatabase(): Promise<string> {
  const base = new URL(process.env.DATABASE_URL ?? '');
  const admin = new URL(base.toString());
  admin.pathname = '/postgres';
  const name = `tally_settlement_books_${randomUUID().replace(/-/g, '')}`;
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
  base.pathname = `/${name}`;
  return base.toString();
}

beforeAll(async () => {
  url = await createDatabase();
  // The store registers the settlements' schema on the database it is given; the database holds the outbox's too.
  const template = new PostgresDatabase(() => url);
  new PostgresSettlementBooks(template);
  for (const setup of template.setups) await setup(template);
  await template.close();
});

const opened: PostgresDatabase[] = [];

const openDatabase = (): PostgresDatabase => {
  const database = new PostgresDatabase(() => url);
  opened.push(database);
  return database;
};

afterAll(async () => {
  // A run of Tally that was stopped in the test has its pool closed already: closing it again is harmless.
  for (const database of opened) await database.close();
});

/**
 * Request 14 over a real PostgreSQL database, with one connection pool per "server" or per run of Tally: a second pool on the same database is
 * a second server on the same database, and a pool opened after the first is closed is Tally started again (docs/adr/0002, docs/adr/0029).
 */

// Each test has a group, a settlement and a payment of its own: the tests share one database, as the servers of one run do.
let GROUP = '';
let PAYER = '';
let PAYEE = '';
let SETTLEMENT = '';
let PAYMENT = '';

beforeEach(() => {
  GROUP = randomUUID();
  PAYER = randomUUID();
  PAYEE = randomUUID();
  SETTLEMENT = randomUUID();
  PAYMENT = `pay-${randomUUID()}`;
});

/** A settlement of 50 from the payer to the payee, pending on the provider's payment: what the first run of Tally recorded. */
async function recordPending(database: PostgresDatabase): Promise<void> {
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
  const unitOfWork = new PostgresUnitOfWork(database);
  await unitOfWork.beginTransaction();
  await new PostgresSettlementBooks(database).save(book);
  await unitOfWork.commitTransaction();
}

/** A webhook as one server of Tally receives it: the use case, run in its own transaction on the database. Its signature is not the subject here. */
async function receive(database: PostgresDatabase, { status }: { status: string }) {
  const context = new ExecutionContext({
    traceId: randomUUID(),
    eventBus: new InMemoryEventBus({ eventEmitter: new EventEmitter(), clock: systemClock }),
    unitOfWork: new PostgresUnitOfWork(database),
    auth: {},
  });
  return receivePaymentWebhook(new PostgresSettlementBooks(database), { isSignedBy: () => true }, systemClock).run(
    { body: randomUUID(), signature: 'signed', paymentId: PAYMENT, status },
    context,
  );
}

const statusOf = async (database: PostgresDatabase): Promise<string> =>
  (await database.get<{ status: string }>('SELECT status FROM settlements WHERE id = ?', [SETTLEMENT]))!.status;

const versionOf = async (database: PostgresDatabase): Promise<number> =>
  Number(
    (await database.get<{ version: number }>('SELECT version FROM settlement_books WHERE group_id = ?', [GROUP]))!
      .version,
  );

describe('webhooks on one database, late and at the same moment (request 14)', () => {
  it('settles a payment that the first run of Tally recorded, when a webhook arrives after Tally was stopped and started again', async () => {
    const first = openDatabase();
    await recordPending(first);
    await first.close();

    const restarted = openDatabase();
    const result = await receive(restarted, { status: 'succeeded' });

    expect(result.isSuccess()).toBe(true);
    expect(await statusOf(restarted)).toBe('paid');
  });

  it('records nothing when a second server receives a webhook the first already settled, and says it is acknowledged', async () => {
    const first = openDatabase();
    await recordPending(first);
    const settled = await receive(first, { status: 'succeeded' });
    expect(settled.isSuccess()).toBe(true);
    expect(await statusOf(first)).toBe('paid');
    expect(await versionOf(first)).toBe(2);

    const second = openDatabase();
    const again = await receive(second, { status: 'succeeded' });

    expect(again.isSuccess()).toBe(true);
    expect(await statusOf(second)).toBe('paid');
    expect(await versionOf(second)).toBe(2);
  });

  it("refuses a save of a book read before another writer's save, so that the use case re-reads and decides again", async () => {
    const database = openDatabase();
    await recordPending(database);
    const books = new PostgresSettlementBooks(database);
    const unitOfWork = new PostgresUnitOfWork(database);

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
    expect(await statusOf(database)).toBe('paid');
    expect(await versionOf(database)).toBe(2);
  });
});
