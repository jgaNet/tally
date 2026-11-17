import { ConcurrencyConflictException } from '@Architecture/Domain';
import { ISettlementBooks } from '@Contexts/Settlements/Application/ISettlementBooks';
import {
  ISettlementQueries,
  SettledTransfer,
  SettlementHistoryLine,
  SettlementView,
} from '@Contexts/Settlements/Domain/ISettlementQueries';
import { PendingTransfer } from '@Contexts/Settlements/Domain/SettlementBook/StillOwed';
import {
  ProviderPayment,
  SettlementBook,
  SettlementMethod,
  SettlementStatus,
} from '@Contexts/Settlements/Domain/SettlementBook/SettlementBook';

import { SettlementsDatabase } from './SettlementsDatabase';

type BookRow = { id: string; version: number };
type SettlementRow = {
  id: string;
  group_id: string;
  payer: string;
  payee: string;
  amount: number;
  method: SettlementMethod;
  status: SettlementStatus;
  at: string;
  provider_payment_id: string | null;
  pay_url: string | null;
};
type HistoryRow = { status: SettlementHistoryLine['status']; at: string };
type HistoryOfGroupRow = HistoryRow & { settlement_id: string };
type LiveRow = {
  id: string;
  payer: string;
  payee: string;
  amount: number;
  provider_payment_id: string;
  pay_url: string;
  status: 'pending' | 'paid' | 'refunding';
};

const LIVE_COLUMNS = 'id, payer, payee, amount, provider_payment_id, pay_url, status';
/** The statuses a provider payment is held in the book in: waiting, paid, or being refunded (request 15). */
const LIVE_STATUSES = "('pending', 'paid', 'refunding')";
/** The statuses the balances count: paid, and being refunded, as the money has not gone back yet (request 15). */
const COUNTED_STATUSES = "('paid', 'refunding')";

/**
 * The settlements in SQLite: the book the use cases load and save (`ISettlementBooks`), and the read side `GetSettlement`, Ledger's
 * `SettledAmounts` and the suggestions read (`ISettlementQueries`). The book's version is checked and stored with the settlements it
 * recorded and the statuses they moved to, in one transaction that holds the database's write lock, so of two writers from one version
 * the second is refused and nothing of its change is kept (CONC-OPTIMISTIC, ADR 11).
 */
export class SqliteSettlements implements ISettlementBooks, ISettlementQueries {
  constructor(private readonly database: SettlementsDatabase) {}

  async bookOf(groupId: string): Promise<SettlementBook> {
    const row = this.database.connection
      .prepare('SELECT id, version FROM settlement_books WHERE group_id = ?')
      .get(groupId) as BookRow | undefined;
    if (!row) return SettlementBook.open(groupId);
    const live = this.database.connection
      .prepare(`SELECT ${LIVE_COLUMNS} FROM settlements WHERE group_id = ? AND status IN ${LIVE_STATUSES}`)
      .all(groupId) as LiveRow[];
    return SettlementBook.fromSnapshot({
      id: row.id,
      groupId,
      version: row.version,
      payments: live.map(toPayment),
    });
  }

  async bookOfPayment(providerPaymentId: string): Promise<SettlementBook | undefined> {
    const row = this.database.connection
      .prepare(`SELECT group_id FROM settlements WHERE provider_payment_id = ? AND status IN ${LIVE_STATUSES}`)
      .get(providerPaymentId) as { group_id: string } | undefined;
    return row ? this.bookOf(row.group_id) : undefined;
  }

  async bookOfSettlement(settlementId: string): Promise<SettlementBook | undefined> {
    const row = this.database.connection.prepare('SELECT group_id FROM settlements WHERE id = ?').get(settlementId) as
      { group_id: string } | undefined;
    return row ? this.bookOf(row.group_id) : undefined;
  }

  inTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.database.file.transaction(work);
  }

  async save(book: SettlementBook): Promise<void> {
    const connection = this.database.connection;
    await this.database.file.transaction(() => {
      const stored = connection.prepare('SELECT version FROM settlement_books WHERE group_id = ?').get(book.groupId) as
        { version: number } | undefined;
      // A book never stored is at version 0; any other is at the version it was stored at.
      if ((stored?.version ?? 0) !== book.version) {
        throw new ConcurrencyConflictException(
          'Settlements',
          'The settlements of the group changed since they were read',
        );
      }
      if (stored) {
        connection
          .prepare('UPDATE settlement_books SET version = ? WHERE group_id = ?')
          .run(book.version + 1, book.groupId);
      } else {
        connection
          .prepare('INSERT INTO settlement_books (id, group_id, version) VALUES (?, ?, ?)')
          .run(book.bookId, book.groupId, book.version + 1);
      }
      const insert = connection.prepare(
        'INSERT INTO settlements (id, group_id, payer, payee, amount, method, status, at, provider_payment_id, pay_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      // Each status a settlement has is a line of its history, written with the fact that moved it (request 19).
      const history = connection.prepare('INSERT INTO settlement_history (settlement_id, status, at) VALUES (?, ?, ?)');
      for (const settlement of book.recorded()) {
        insert.run(
          settlement.id,
          settlement.groupId,
          settlement.from,
          settlement.to,
          settlement.amount,
          settlement.method,
          settlement.status,
          settlement.at,
          settlement.providerPaymentId ?? null,
          settlement.payUrl ?? null,
        );
        history.run(settlement.id, settlement.status, settlement.at);
      }
      const update = connection.prepare('UPDATE settlements SET status = ? WHERE id = ?');
      for (const { id, status, at } of book.moved()) {
        update.run(status, id);
        history.run(id, status, at);
      }
    });
  }

  async settlementOf(id: string): Promise<SettlementView | undefined> {
    const row = this.database.connection
      .prepare('SELECT id, group_id, payer, payee, amount, method, status, at, pay_url FROM settlements WHERE id = ?')
      .get(id) as SettlementRow | undefined;
    if (!row) return undefined;
    const history = this.database.connection
      .prepare('SELECT status, at FROM settlement_history WHERE settlement_id = ? ORDER BY seq')
      .all(id) as HistoryRow[];
    return toView(row, history);
  }

  async settlementsOf(groupId: string): Promise<SettlementView[]> {
    const rows = this.database.connection
      .prepare(
        'SELECT id, group_id, payer, payee, amount, method, status, at, pay_url FROM settlements WHERE group_id = ? ORDER BY at DESC, rowid DESC',
      )
      .all(groupId) as SettlementRow[];
    const lines = this.database.connection
      .prepare(
        `SELECT h.settlement_id, h.status, h.at FROM settlement_history h
         JOIN settlements s ON s.id = h.settlement_id WHERE s.group_id = ? ORDER BY h.seq`,
      )
      .all(groupId) as HistoryOfGroupRow[];
    const historyOf = new Map<string, HistoryRow[]>();
    for (const { settlement_id, status, at } of lines) {
      historyOf.set(settlement_id, [...(historyOf.get(settlement_id) ?? []), { status, at }]);
    }
    return rows.map(row => toView(row, historyOf.get(row.id) ?? []));
  }

  async settledOf(groupId: string): Promise<SettledTransfer[]> {
    const rows = this.database.connection
      .prepare(`SELECT payer, payee, amount FROM settlements WHERE group_id = ? AND status IN ${COUNTED_STATUSES}`)
      .all(groupId) as { payer: string; payee: string; amount: number }[];
    return rows.map(row => ({ from: row.payer, to: row.payee, amount: row.amount }));
  }

  async hasWaitingPayment(groupId: string, memberId: string): Promise<boolean> {
    const row = this.database.connection
      .prepare(
        `SELECT 1 AS waiting FROM settlements
          WHERE group_id = ? AND method = 'provider' AND status IN ('pending', 'refunding') AND (payer = ? OR payee = ?)
          LIMIT 1`,
      )
      .get(groupId, memberId, memberId);
    return row !== undefined;
  }

  async pendingOf(groupId: string): Promise<PendingTransfer[]> {
    const rows = this.database.connection
      .prepare(`SELECT ${LIVE_COLUMNS} FROM settlements WHERE group_id = ? AND status = 'pending'`)
      .all(groupId) as LiveRow[];
    return rows.map(row => ({ from: row.payer, to: row.payee, amount: row.amount }));
  }
}

/** A settlement as a read model has it: its row, and its history, the earliest first. */
const toView = (row: SettlementRow, history: HistoryRow[]): SettlementView => ({
  id: row.id,
  groupId: row.group_id,
  from: row.payer,
  to: row.payee,
  amount: row.amount,
  method: row.method,
  status: row.status,
  at: row.at,
  ...(row.pay_url !== null && { payUrl: row.pay_url }),
  history: history.map(({ status, at }) => ({ status, at })),
});

const toPayment = (row: LiveRow): ProviderPayment => ({
  id: row.id,
  from: row.payer,
  to: row.payee,
  amount: row.amount,
  providerPaymentId: row.provider_payment_id,
  payUrl: row.pay_url,
  status: row.status,
});
