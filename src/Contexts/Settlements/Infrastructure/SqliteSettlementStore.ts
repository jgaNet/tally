import { ConcurrencyConflictException } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ISettlementStore, SettlementView } from '@Contexts/Settlements/Application/ISettlementStore';
import { WaitingPayment, SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { Settlement, SettlementMethod, SettlementStatus } from '@Contexts/Settlements/Domain/Settlement/Settlement';

/**
 * The settlements' tables (features 12 and 13, ADR 10). `settlement_books` is the version each group's book is at: one row per group
 * with a settlement, written with the first one and bumped with each change after it, only while the book is still at the version it
 * was read at. `settlements` is one row per settlement, in cash or through the provider (`method`), kept as it was decided, and its
 * `status` (`pending` while the provider has not said, `paid`, `failed`, and for a refund `refunding` and `refunded`) is the one thing that
 * changes after it is decided; a
 * provider's payment keeps the provider's id (`payment_id`, the webhook names it) and the link the payer pays at (`pay_url`). The
 * balances read the paid ones through `SqliteSettlementRoster`, so a settlement is counted once it is paid. The group is a group of
 * Groups: the foreign key only names its id, as Ledger's does.
 */
export const settlementsTablesSchema = [
  `CREATE TABLE IF NOT EXISTS settlement_books (
     group_id TEXT PRIMARY KEY REFERENCES groups(id),
     version INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS settlements (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL REFERENCES groups(id),
     payer_id TEXT NOT NULL,
     payee_id TEXT NOT NULL,
     amount INTEGER NOT NULL,
     method TEXT NOT NULL CHECK (method IN ('cash', 'provider')),
     status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded')),
     recorded_at TEXT NOT NULL,
     payment_id TEXT UNIQUE,
     pay_url TEXT,
     CHECK (method = 'cash' OR (payment_id IS NOT NULL AND pay_url IS NOT NULL))
   )`,
  'CREATE INDEX IF NOT EXISTS settlements_by_group ON settlements (group_id)',
];

interface SettlementRow {
  id: string;
  group_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  method: SettlementMethod;
  status: SettlementStatus;
  recorded_at: string;
  payment_id: string | null;
  pay_url: string | null;
}

/** A settlement row as the domain keeps it. */
const toSettlement = (row: SettlementRow): Settlement => ({
  id: row.id,
  groupId: row.group_id,
  from: row.payer_id,
  to: row.payee_id,
  amount: row.amount,
  method: row.method,
  status: row.status,
  at: row.recorded_at,
  ...(row.payment_id !== null && row.pay_url !== null && { payment: { id: row.payment_id, payUrl: row.pay_url } }),
});

/** What a screen shows of a settlement: the link the payer pays at, through the provider only. */
const toView = (settlement: Settlement): SettlementView => ({
  id: settlement.id,
  groupId: settlement.groupId,
  from: settlement.from,
  to: settlement.to,
  amount: settlement.amount,
  method: settlement.method,
  status: settlement.status,
  at: settlement.at,
  ...(settlement.payment && { payUrl: settlement.payment.payUrl }),
});

/**
 * The settlements in SQLite. `save` checks the group's book is still at the version it was read at, and stores the next one with the
 * settlement (or its new status), in the command's transaction; it refuses a book another writer moved on with a
 * ConcurrencyConflictException (CONC-OPTIMISTIC). `versionOf`, `waitingOf`, `settlementOfPayment`, `settlementOf` and `viewOf` read the
 * committed data.
 */
export class SqliteSettlementStore implements ISettlementStore {
  constructor(private readonly database: SqliteDatabase) {}

  async versionOf(groupId: string): Promise<number> {
    const row = this.database.read(db =>
      db.prepare('SELECT version FROM settlement_books WHERE group_id = ?').get(groupId),
    ) as { version: number } | undefined;
    return row?.version ?? 0;
  }

  async waitingOf(groupId: string): Promise<WaitingPayment[]> {
    const rows = this.database.read(db =>
      db
        .prepare("SELECT payer_id, payee_id, amount FROM settlements WHERE group_id = ? AND status = 'pending'")
        .all(groupId),
    ) as { payer_id: string; payee_id: string; amount: number }[];
    return rows.map(row => ({ from: row.payer_id, to: row.payee_id, amount: row.amount }));
  }

  async save(book: SettlementBook, settlement: Settlement): Promise<void> {
    this.#checkVersion(book);
    this.database.writer
      .prepare(
        `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, recorded_at, payment_id, pay_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status`,
      )
      .run(
        settlement.id,
        settlement.groupId,
        settlement.from,
        settlement.to,
        settlement.amount,
        settlement.method,
        settlement.status,
        settlement.at,
        settlement.payment?.id ?? null,
        settlement.payment?.payUrl ?? null,
      );
  }

  async viewOf(settlementId: string): Promise<SettlementView | undefined> {
    const row = this.database.read(db => db.prepare('SELECT * FROM settlements WHERE id = ?').get(settlementId)) as
      SettlementRow | undefined;
    return row ? toView(toSettlement(row)) : undefined;
  }

  async settlementOf(settlementId: string): Promise<Settlement | undefined> {
    const row = this.database.read(db => db.prepare('SELECT * FROM settlements WHERE id = ?').get(settlementId)) as
      SettlementRow | undefined;
    return row ? toSettlement(row) : undefined;
  }

  async settlementOfPayment(paymentId: string): Promise<Settlement | undefined> {
    const row = this.database.read(db =>
      db.prepare('SELECT * FROM settlements WHERE payment_id = ?').get(paymentId),
    ) as SettlementRow | undefined;
    return row ? toSettlement(row) : undefined;
  }

  /** Stores the book at its version + 1, only if it is still at the version it was read at; the first settlement creates the row. */
  #checkVersion(book: SettlementBook): void {
    const writer = this.database.writer;
    const { changes } =
      book.version === 0
        ? writer.prepare('INSERT OR IGNORE INTO settlement_books (group_id, version) VALUES (?, 1)').run(book.groupId)
        : writer
            .prepare('UPDATE settlement_books SET version = ? WHERE group_id = ? AND version = ?')
            .run(book.version + 1, book.groupId, book.version);
    if (changes === 0) {
      throw new ConcurrencyConflictException(
        'Settlements',
        'The settlements of the group changed since they were read: read them again',
      );
    }
  }
}
