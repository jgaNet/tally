import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { PostgresDatabase, closeDatabases } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PostgresOutbox } from '@Architecture/Infrastructure/Postgres/PostgresOutbox';
import { moveFromFile } from '@Bootstrap/Fastify/moveFromFile';
import { createGroupsTables } from '@Contexts/Groups/Infrastructure/GroupsTables';
import { createLedgerTables } from '@Contexts/Ledger/Infrastructure/LedgerTables';
import { createNoticesTables } from '@Contexts/Notifications/Infrastructure/NoticesTables';
import { createSettlementsTables } from '@Contexts/Settlements/Infrastructure/SettlementsTables';

const database = () => {
  const made = new PostgresDatabase(process.env.DATABASE_URL as string, `move_${randomBytes(6).toString('hex')}`);
  createGroupsTables(made);
  createLedgerTables(made);
  createSettlementsTables(made);
  createNoticesTables(made);
  new PostgresOutbox(made);
  return made;
};

/** A file as an earlier version of the application left it: before histories, join times, recording orders and reminders. */
const oldFile = (directory: string): string => {
  const path = `${directory}/tally.sqlite`;
  const file = new DatabaseSync(path);
  file.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('token-secret', 'kept');
    CREATE TABLE outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL);
    INSERT INTO outbox VALUES ('o1', 'domain', 'First', '{}'), ('o2', 'domain', 'Second', '{"n":2}');
    CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, owner_id TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO groups VALUES ('g1', 'Flat', 'EUR', 'ann', '2026-01-01T10:00:00.000Z');
    CREATE TABLE group_members (group_id TEXT NOT NULL, account_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (group_id, account_id));
    INSERT INTO group_members VALUES ('g1', 'ann', 0);
    CREATE TABLE expenses (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL, spent_on TEXT NOT NULL, paid_by TEXT NOT NULL);
    INSERT INTO expenses VALUES ('e2', 'g1', 'milk', 40, '2026-01-02', 'ann'), ('e1', 'g1', 'rent', 300, '2026-01-01', 'ann');
    CREATE TABLE notices (id TEXT PRIMARY KEY, recipient TEXT NOT NULL, group_id TEXT NOT NULL, expense_id TEXT NOT NULL, amount INTEGER NOT NULL, recorded_at TEXT NOT NULL);
    INSERT INTO notices VALUES ('n1', 'bob', 'g1', 'e1', 100, '2026-01-01T10:00:00.000Z');
    CREATE TABLE settlements (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, payer TEXT NOT NULL, payee TEXT NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL, recorded_at TEXT NOT NULL, provider_payment_id TEXT, pay_url TEXT);
    INSERT INTO settlements VALUES ('s1', 'g1', 'bob', 'ann', 30, 'provider', 'pending', '2026-01-03T10:00:00.000Z', 'pay_1', 'https://pay/1');
  `);
  file.close();
  return path;
};

describe('the move from the SQLite file into PostgreSQL (ADR 21)', () => {
  afterAll(closeDatabases);

  it('moves what a file of an earlier version held, once, and does not read the file again', async () => {
    const directory = mkdtempSync(`${tmpdir()}/tally-move-`);
    try {
      const path = oldFile(directory);
      const target = database();
      const secret = target.setting('token-secret', () => 'new');

      await target.prepare(moveFromFile(path));

      expect(secret()).toBe('kept');
      expect((await target.all<{ id: string }>('SELECT id FROM outbox ORDER BY seq')).map(row => row.id)).toEqual([
        'o1',
        'o2',
      ]);
      expect(
        (await target.all<{ id: string }>('SELECT id FROM expenses ORDER BY recorded_seq')).map(row => row.id),
      ).toEqual(['e2', 'e1']);
      expect(await target.get('SELECT joined_at, left_at FROM group_members')).toEqual({
        joined_at: '2026-01-01T10:00:00.000Z',
        left_at: null,
      });
      expect(await target.get('SELECT kind, category FROM notices')).toEqual({ kind: 'expense', category: null });
      expect(await target.get('SELECT status, provider_payment_id, pay_url FROM settlements')).toEqual({
        status: 'pending',
        provider_payment_id: 'pay_1',
        pay_url: 'https://pay/1',
      });
      expect(await target.all('SELECT status, learned_at FROM settlement_history')).toEqual([
        { status: 'pending', learned_at: '2026-01-03T10:00:00.000Z' },
      ]);

      // A second server on the same database, with the file gone, finds it done and moves nothing.
      rmSync(path);
      const second = new PostgresDatabase(target.url, target.schema);
      await second.prepare(moveFromFile(path));
      expect(await second.get('SELECT count(*) AS n FROM expenses')).toEqual({ n: 2 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('prepares an empty database at once when there is no file', async () => {
    const target = database();
    await target.prepare(moveFromFile('/nonexistent/tally.sqlite'));
    expect(await target.get('SELECT count(*) AS n FROM expenses')).toEqual({ n: 0 });
  });
});
