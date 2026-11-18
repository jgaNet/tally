import { Id } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PostgresUnitOfWork } from '@Architecture/Infrastructure/Postgres/PostgresUnitOfWork';
import { freshDatabase } from '@Architecture/Infrastructure/Postgres/database.spec-helper';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { PostgresSettlementBookRepository } from '@Contexts/Settlements/Infrastructure/PostgresSettlementBookRepository';

const NOW = new Date('2026-11-01T10:00:00.000Z');

const at = new Date('2026-11-01T10:00:00.000Z');
const payer = new Id('payer');
const payee = new Id('payee');
const members = ['payer', 'payee'];
const balances = new Map([
  ['payer', -30],
  ['payee', 30],
]);

/** A database that Tally is stopped and started on: each start is a server of its own on the same database. */
let database: PostgresDatabase;
const opened: PostgresDatabase[] = [];

interface Server {
  database: PostgresDatabase;
  repository: PostgresSettlementBookRepository;
  /** Runs `fn` in a transaction of its own, committed, as a command's handler does. */
  inTransaction<T>(fn: (repository: PostgresSettlementBookRepository) => Promise<T>): Promise<T>;
}

function start(): Server {
  const server = new PostgresDatabase(database.url);
  opened.push(server);
  const repository = new PostgresSettlementBookRepository(server);
  return {
    database: server,
    repository,
    async inTransaction(fn) {
      const unit = new PostgresUnitOfWork(server);
      await unit.beginTransaction();
      try {
        const result = await fn(repository);
        await unit.commitTransaction();
        return result;
      } catch (error) {
        await unit.rollbackTransaction();
        throw error;
      }
    },
  };
}

async function stop(server: Server) {
  await server.database.close();
}

beforeEach(() => {
  database = freshDatabase();
});

afterEach(async () => {
  for (const server of opened.splice(0)) await server.close();
  await database.close();
});

describe('PostgresSettlementBookRepository: a webhook that is late, or at the same moment, counts a payment once', () => {
  it('finds a payment still pending after Tally was stopped and started, and counts it once the provider says it succeeded', async () => {
    const groupId = Id.generate();
    const first = start();
    const book = SettlementBook.open(groupId, 0);
    const proposal = book.proposePayment({
      groupArchived: false,
      payer,
      payee,
      amount: 30,
      balances,
      members,
      payeeAccount: 'acct-payee',
    });
    if (proposal.isFailure()) throw new Error('refused');
    book.keepPayment(proposal.data, { id: 'late-pay', payUrl: 'https://pay.example/late-pay' }, at);
    expect((await first.inTransaction(repository => repository.save(book))).isSuccess()).toBe(true);
    await stop(first);

    const second = start();
    await second.inTransaction(async repository => {
      const late = await repository.findByPaymentId('late-pay');
      expect(late).not.toBeNull();
      late!.receivePayment({ paymentId: 'late-pay', status: 'succeeded', at: NOW });
      expect(late!.unsaved).toHaveLength(1);
      expect(late!.unsaved[0].status).toBe('paid');
      expect((await repository.save(late!)).isSuccess()).toBe(true);
    });
    await stop(second);

    const third = start();
    const after = await third.inTransaction(repository => repository.findByPaymentId('late-pay'));
    after!.receivePayment({ paymentId: 'late-pay', status: 'pending', at: NOW });
    after!.receivePayment({ paymentId: 'late-pay', status: 'failed', at: NOW });
    expect(after!.unsaved).toHaveLength(0);
  });

  it('refuses the second of two books read at the same version, which re-reads a payment the first already paid', async () => {
    const groupId = Id.generate();
    const setup = start();
    const book = SettlementBook.open(groupId, 0);
    const proposal = book.proposePayment({
      groupArchived: false,
      payer,
      payee,
      amount: 30,
      balances,
      members,
      payeeAccount: 'acct-payee',
    });
    if (proposal.isFailure()) throw new Error('refused');
    book.keepPayment(proposal.data, { id: 'shared-pay', payUrl: 'https://pay.example/shared-pay' }, at);
    await setup.inTransaction(repository => repository.save(book));

    // Two servers on the same database read the same book, and both hear the same webhook.
    const server = start();
    const other = start();
    const firstReading = await server.inTransaction(repository => repository.findByPaymentId('shared-pay'));
    const secondReading = await other.inTransaction(repository => repository.findByPaymentId('shared-pay'));
    firstReading!.receivePayment({ paymentId: 'shared-pay', status: 'succeeded', at: NOW });
    secondReading!.receivePayment({ paymentId: 'shared-pay', status: 'succeeded', at: NOW });

    expect((await server.inTransaction(repository => repository.save(firstReading!))).isSuccess()).toBe(true);
    const conflict = await other.inTransaction(repository => repository.save(secondReading!));
    expect(conflict.isFailure()).toBe(true);
    expect((conflict.error as { type?: string }).type).toBe('ConcurrencyConflict');

    // The second server re-reads in a new transaction: the payment is paid already, so it records nothing.
    const reread = await other.inTransaction(repository => repository.findByPaymentId('shared-pay'));
    reread!.receivePayment({ paymentId: 'shared-pay', status: 'succeeded', at: NOW });
    expect(reread!.unsaved).toHaveLength(0);
  });

  it('moves a pending payment copied from an SQLite file forward once, when its webhook arrives after the move', async () => {
    // What the move writes: the rows of the file, column by column, the history with the ids it had there.
    const moved = start();
    await moved.database.ready();
    await moved.database.underSchemaLock(async connection => {
      await connection.run(`INSERT INTO settlement_books (group_id, version) VALUES ('moved-group', 1)`);
      await connection.run(
        `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, recorded_at, provider_payment_id, pay_url)
         VALUES ('moved-settlement', 'moved-group', 'payer', 'payee', 30, 'provider', 'pending', ?, 'moved-pay', 'https://pay.example/moved-pay')`,
        at.toISOString(),
      );
      await connection.run(
        `INSERT INTO settlement_history (id, settlement_id, status, at) VALUES (7, 'moved-settlement', 'pending', ?)`,
        at.toISOString(),
      );
    });
    await stop(moved);

    const server = start();
    await server.inTransaction(async repository => {
      const book = await repository.findByPaymentId('moved-pay');
      book!.receivePayment({ paymentId: 'moved-pay', status: 'succeeded', at: NOW });
      expect(book!.unsaved).toHaveLength(1);
      expect((await repository.save(book!)).isSuccess()).toBe(true);
    });
    const after = await server.inTransaction(repository => repository.findByPaymentId('moved-pay'));
    after!.receivePayment({ paymentId: 'moved-pay', status: 'succeeded', at: NOW });
    expect(after!.unsaved).toHaveLength(0);
    const history = await server.database.exclusive(connection =>
      connection.rows<{ id: number; status: string }>(
        `SELECT id, status FROM settlement_history WHERE settlement_id = 'moved-settlement' ORDER BY id`,
      ),
    );
    expect(history).toEqual([
      { id: 7, status: 'pending' },
      { id: 8, status: 'paid' },
    ]);
  });
});
