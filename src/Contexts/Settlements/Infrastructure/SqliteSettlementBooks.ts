import { DatabaseSync } from 'node:sqlite';

import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SettlementMethod, SettlementStatus, SettlementView } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import {
  PaidSettlement,
  PendingSettlement,
  SettlementBook,
} from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { ISettlementBooks } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBooks';

/**
 * The tables of the settlements: a group's book is a row holding its version, and each settlement is a row of its own. The
 * book's row is what a save checks (docs/adr/0013); a settlement is changed only by its status: pending to paid or failed, paid to
 * refunding, and to refunded (requests 13 and 15). A settlement through the provider keeps the link its payer pays at and the
 * provider's id for its payment, which its webhook names.
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
  // Each status a settlement has had, in the order the book recorded it, and when Tally learned it (request 19). Written by the book's
  // save, in its transaction. A file made before request 19 has the settlements without their lines: each gets the one its method
  // recorded it with, at the time it was recorded, which is all that file knows of it.
  connection.exec(
    [
      'CREATE TABLE IF NOT EXISTS settlement_statuses (settlement_id TEXT NOT NULL, status TEXT NOT NULL, learned_at TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS settlement_statuses_by_settlement ON settlement_statuses (settlement_id)',
    ].join(';\n'),
  );
  // The group's audit of the changes of money the book makes, one row each, never changed (request 28, docs/adr/0027).
  connection.exec(
    'CREATE TABLE IF NOT EXISTS settlement_audit (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, at TEXT NOT NULL, by_id TEXT NOT NULL, action TEXT NOT NULL, subject_id TEXT NOT NULL, amount INTEGER NOT NULL)',
  );
  // Read first: a file with every settlement's line is only read, never written (a write here would lock the file for the others).
  const unlined = connection
    .prepare(
      'SELECT 1 FROM settlements s WHERE NOT EXISTS (SELECT 1 FROM settlement_statuses l WHERE l.settlement_id = s.id) LIMIT 1',
    )
    .get();
  if (unlined) {
    connection.exec(
      "INSERT INTO settlement_statuses (settlement_id, status, learned_at) SELECT id, CASE method WHEN 'cash' THEN 'paid' ELSE 'pending' END, recorded_at FROM settlements s WHERE NOT EXISTS (SELECT 1 FROM settlement_statuses l WHERE l.settlement_id = s.id)",
    );
  }
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
    const paid = connection
      .prepare(
        "SELECT id, payer_id, payee_id, amount, provider_payment_id, status FROM settlements WHERE group_id = ? AND method = 'provider' AND status IN ('paid', 'refunding') ORDER BY recorded_at, rowid",
      )
      .all(groupId) as PaidRow[];
    return SettlementBook.fromSnapshot({
      groupId,
      version: row ? Number(row.version) : 0,
      pending: pending.map(pendingOf),
      paid: paid.map(paidOf),
    });
  }

  async ofPayment(providerPaymentId: string): Promise<SettlementBook | undefined> {
    this.database.assertInTransaction();
    const row = this.database.connection
      .prepare('SELECT group_id FROM settlements WHERE provider_payment_id = ?')
      .get(providerPaymentId) as { group_id: string } | undefined;
    return row ? this.get(String(row.group_id)) : undefined;
  }

  async ofSettlement(settlementId: string): Promise<SettlementBook | undefined> {
    this.database.assertInTransaction();
    const row = this.database.connection.prepare('SELECT group_id FROM settlements WHERE id = ?').get(settlementId) as
      { group_id: string } | undefined;
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

    // Each status the book records is a line of the history, written with the fact, in this transaction (request 19).
    const insert = connection.prepare(
      'INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, recorded_at, pay_url, provider_payment_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const learn = connection.prepare(
      'INSERT INTO settlement_statuses (settlement_id, status, learned_at) VALUES (?, ?, ?)',
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
      learn.run(settlement.id, settlement.status, settlement.at);
    }

    const move = connection.prepare('UPDATE settlements SET status = ? WHERE id = ?');
    for (const each of book.moved) {
      move.run(each.status, each.id);
      learn.run(each.id, each.status, each.at);
    }

    // Each change of money the book made is an entry of the group's audit, written with it in this transaction (request 28, docs/adr/0027).
    const audit = connection.prepare(
      'INSERT INTO settlement_audit (id, group_id, at, by_id, action, subject_id, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const change of book.audited) {
      audit.run(change.id, groupId, change.at, change.by, change.action, change.subjectId, change.amount);
    }
    return Result.ok(undefined);
  }
}

const changedSinceRead = () =>
  new ConcurrencyConflictException('Settlements', 'The settlements of the group changed since they were read');

type PendingRow = { id: string; payer_id: string; payee_id: string; amount: number; provider_payment_id: string };
type PaidRow = PendingRow & { status: string };

const pendingOf = (row: PendingRow): PendingSettlement => ({
  id: String(row.id),
  from: String(row.payer_id),
  to: String(row.payee_id),
  amount: Number(row.amount),
  providerPaymentId: String(row.provider_payment_id),
});

const paidOf = (row: PaidRow): PaidSettlement => ({
  ...pendingOf(row),
  status: String(row.status) as PaidSettlement['status'],
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
