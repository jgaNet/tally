import { DatabaseSync } from 'node:sqlite';

import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SettlementMethod, SettlementStatus, SettlementView } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import { PendingSettlement, SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { ISettlementBooks } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBooks';

/**
 * The tables of the settlements: a group's book is a row holding its version, and each settlement is a row of its own. The
 * book's row is what a save checks (docs/adr/0013); a settlement is changed only by its status, once it is pending (request 13).
 * A settlement through the provider keeps the link its payer pays at and the provider's id for its payment, which its webhook names.
 */
export function prepareSettlementSchema(connection: DatabaseSync): void {
  connection.exec(
    [
      'CREATE TABLE IF NOT EXISTS settlement_books (group_id TEXT PRIMARY KEY, version INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS settlements (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, payer_id TEXT NOT NULL, payee_id TEXT NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL, recorded_at TEXT NOT NULL, pay_url TEXT, provider_payment_id TEXT)',
    ].join(';\n'),
  );
  // A file made before request 13 has the table without the provider's columns: they are added, once.
  const columns = (connection.prepare('PRAGMA table_info(settlements)').all() as Array<{ name: string }>).map(
    column => column.name,
  );
  if (!columns.includes('pay_url')) connection.exec('ALTER TABLE settlements ADD COLUMN pay_url TEXT');
  if (!columns.includes('provider_payment_id')) {
    connection.exec('ALTER TABLE settlements ADD COLUMN provider_payment_id TEXT');
  }
  connection.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS settlements_by_provider_payment ON settlements (provider_payment_id)',
  );
}

/**
 * The settlement books' store over SQLite (docs/adr/0013, docs/adr/0014). Its methods run inside a transaction: the use case's. A save of
 * a book read at a version another writer has moved past changes nothing and answers a conflict, so the use case re-reads and decides
 * again (CONC-OPTIMISTIC). A group's first settlement inserts its book's row: two first settlements at once meet the same check.
 */
export class SqliteSettlementBooks implements ISettlementBooks {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareSettlementSchema);
  }

  async get(groupId: string): Promise<SettlementBook> {
    this.database.assertInTransaction();
    const connection = this.database.connection;
    const row = connection.prepare('SELECT version FROM settlement_books WHERE group_id = ?').get(groupId) as
      { version: number } | undefined;
    const pending = connection
      .prepare(
        "SELECT id, payer_id, payee_id, amount, provider_payment_id FROM settlements WHERE group_id = ? AND status = 'pending' ORDER BY recorded_at, rowid",
      )
      .all(groupId) as PendingRow[];
    return SettlementBook.fromSnapshot({
      groupId,
      version: row ? Number(row.version) : 0,
      pending: pending.map(pendingOf),
    });
  }

  async ofPayment(providerPaymentId: string): Promise<SettlementBook | undefined> {
    this.database.assertInTransaction();
    const row = this.database.connection
      .prepare('SELECT group_id FROM settlements WHERE provider_payment_id = ?')
      .get(providerPaymentId) as { group_id: string } | undefined;
    return row ? this.get(String(row.group_id)) : undefined;
  }

  async save(book: SettlementBook): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const connection = this.database.connection;
    const groupId = book.groupId;
    if (book.version === 0) {
      const { changes } = connection
        .prepare('INSERT INTO settlement_books (group_id, version) VALUES (?, ?) ON CONFLICT (group_id) DO NOTHING')
        .run(groupId, 1);
      if (changes === 0) return Result.fail(changedSinceRead());
    } else {
      const { changes } = connection
        .prepare('UPDATE settlement_books SET version = ? WHERE group_id = ? AND version = ?')
        .run(book.version + 1, groupId, book.version);
      if (changes === 0) return Result.fail(changedSinceRead());
    }

    const insert = connection.prepare(
      'INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, recorded_at, pay_url, provider_payment_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const settlement of book.recorded) {
      insert.run(
        settlement.id,
        settlement.groupId,
        settlement.from,
        settlement.to,
        settlement.amount,
        settlement.method,
        settlement.status,
        settlement.at,
        settlement.payUrl ?? null,
        settlement.providerPaymentId ?? null,
      );
    }

    const settle = connection.prepare("UPDATE settlements SET status = ? WHERE id = ? AND status = 'pending'");
    for (const ended of book.ended) settle.run(ended.status, ended.id);
    return Result.ok(undefined);
  }
}

const changedSinceRead = () =>
  new ConcurrencyConflictException('Settlements', 'The settlements of the group changed since they were read');

type PendingRow = { id: string; payer_id: string; payee_id: string; amount: number; provider_payment_id: string };

const pendingOf = (row: PendingRow): PendingSettlement => ({
  id: String(row.id),
  from: String(row.payer_id),
  to: String(row.payee_id),
  amount: Number(row.amount),
  providerPaymentId: String(row.provider_payment_id),
});

/** The settlement a row holds, as `GetSettlement` answers it. Exported for the read side of the same tables. */
export type SettlementRow = {
  id: string;
  group_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  method: string;
  status: string;
  recorded_at: string;
  pay_url: string | null;
};

export function settlementView(row: SettlementRow): SettlementView {
  const view: SettlementView = {
    id: String(row.id),
    groupId: String(row.group_id),
    from: String(row.payer_id),
    to: String(row.payee_id),
    amount: Number(row.amount),
    method: String(row.method) as SettlementMethod,
    status: String(row.status) as SettlementStatus,
    at: String(row.recorded_at),
  };
  // A settlement through the provider has its payUrl; a cash one has none, and the answer does not say so (request 13).
  if (row.pay_url) view.payUrl = String(row.pay_url);
  return view;
}
