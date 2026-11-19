import { ConcurrencyConflictException } from '@Architecture/Domain';
import { ISettlementBooks } from '@Contexts/Settlements/Application/ISettlementBooks';
import {
  AdministratorDecisionLine,
  CountedSettlement,
  ISettlementQueries,
  NettingView,
  SettledTransfer,
  SettlementAuditLine,
  SettlementHistoryLine,
  SettlementView,
} from '@Contexts/Settlements/Domain/ISettlementQueries';
import { PendingTransfer } from '@Contexts/Settlements/Domain/SettlementBook/StillOwed';
import { DEFAULT_FEE_BORNE, FeeBorne, isFeeBorne } from '@Contexts/Settlements/Domain/SettlementBook/ProviderFee';
import {
  ProviderPayment,
  SettlementBook,
  SettlementMethod,
  SettlementStatus,
} from '@Contexts/Settlements/Domain/SettlementBook/SettlementBook';

import { SettlementsDatabase } from './SettlementsDatabase';

type BookRow = { id: string; version: number; fee_borne_by: string };
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
  fee_amount: number | null;
  fee_borne_by: string | null;
  /** What was paid in another currency (request 39): all three are null for a settlement in the group's currency. */
  original_currency: string | null;
  original_amount: number | null;
  original_rate: string | null;
};
type CountedRow = {
  id: string;
  payer: string;
  payee: string;
  amount: number;
  method: SettlementMethod;
  counted_at: string;
};
type HistoryRow = { status: SettlementHistoryLine['status']; at: string };
type AdministratorLogRow = {
  id: string;
  at: string;
  by_account: string;
  action: AdministratorDecisionLine['action'];
  subject_id: string;
};
type HistoryOfGroupRow = HistoryRow & { settlement_id: string };
type AuditRow = {
  id: string;
  payer: string;
  payee: string;
  amount: number;
  method: SettlementMethod;
  status: SettlementHistoryLine['status'];
  at: string;
  /** Who asked the netting the settlement was made by (request 32); null for any other settlement. */
  netted_by: string | null;
  /** Who decided the settlement paid again, an administrator (request 33); null for any other line. */
  decided_by: string | null;
};
type NettingRow = { id: string; asked_by: string; asked_with: string; currency: string; amount: number };
type LiveRow = {
  id: string;
  payer: string;
  payee: string;
  amount: number;
  settled: number;
  provider_payment_id: string;
  pay_url: string;
  status: 'pending' | 'paid' | 'refunding' | 'contested';
};

/** The columns a live payment is read with: what it settles is its settled amount, or its amount when it was kept before the fee (request 38). */
const LIVE_COLUMNS =
  'id, payer, payee, amount, COALESCE(settled, amount) AS settled, provider_payment_id, pay_url, status';
/** The columns a settlement is read with, its fee included (request 38). */
const VIEW_COLUMNS =
  'id, group_id, payer, payee, amount, method, status, at, pay_url, fee_amount, fee_borne_by, original_currency, original_amount, original_rate';
/** The statuses a provider payment is held in the book in: waiting, paid, being refunded (request 15), or contested (request 33). */
const LIVE_STATUSES = "('pending', 'paid', 'refunding', 'contested')";
/** The statuses the balances count: paid, and being refunded, as the money has not gone back yet (request 15). */
const COUNTED_STATUSES = "('paid', 'refunding')";

/**
 * The settlements in PostgreSQL: the book the use cases load and save (`ISettlementBooks`), and the read side `GetSettlement`, Ledger's
 * `SettledAmounts` and the suggestions read (`ISettlementQueries`). The book's version is checked and stored with the settlements it
 * recorded and the statuses they moved to, in one transaction that takes the database's writers' lock, so of two writers from one version
 * the second is refused and nothing of its change is kept (CONC-OPTIMISTIC, ADR 11).
 */
export class SqliteSettlements implements ISettlementBooks, ISettlementQueries {
  constructor(private readonly database: SettlementsDatabase) {}

  async bookOf(groupId: string): Promise<SettlementBook> {
    const row = await this.database.row<BookRow>(
      'SELECT id, version, fee_borne_by FROM settlement_books WHERE group_id = $1',
      [groupId],
    );
    if (!row) return SettlementBook.open(groupId);
    const live = await this.database.rows<LiveRow>(
      `SELECT ${LIVE_COLUMNS} FROM settlements WHERE group_id = $1 AND status IN ${LIVE_STATUSES} ORDER BY seq`,
      [groupId],
    );
    return SettlementBook.fromSnapshot({
      id: row.id,
      groupId,
      version: row.version,
      payments: live.map(toPayment),
      feeBorneBy: toFeeBorne(row.fee_borne_by),
    });
  }

  async bookOfPayment(providerPaymentId: string): Promise<SettlementBook | undefined> {
    const row = await this.database.row<{ group_id: string }>(
      `SELECT group_id FROM settlements WHERE provider_payment_id = $1 AND status IN ${LIVE_STATUSES}`,
      [providerPaymentId],
    );
    return row ? this.bookOf(row.group_id) : undefined;
  }

  async bookOfSettlement(settlementId: string): Promise<SettlementBook | undefined> {
    const row = await this.database.row<{ group_id: string }>('SELECT group_id FROM settlements WHERE id = $1', [
      settlementId,
    ]);
    return row ? this.bookOf(row.group_id) : undefined;
  }

  inTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.database.transaction(work);
  }

  async save(book: SettlementBook): Promise<void> {
    await this.database.transaction(async () => {
      const stored = await this.database.row<{ version: number }>(
        'SELECT version FROM settlement_books WHERE group_id = $1',
        [book.groupId],
      );
      // A book never stored is at version 0; any other is at the version it was stored at.
      if ((stored?.version ?? 0) !== book.version) {
        throw new ConcurrencyConflictException(
          'Settlements',
          'The settlements of the group changed since they were read',
        );
      }
      // The book keeps who bears the provider's fee, as the owner decided it (request 38), with its version.
      if (stored) {
        await this.database.execute('UPDATE settlement_books SET version = $1, fee_borne_by = $2 WHERE group_id = $3', [
          book.version + 1,
          book.feeBorneBy,
          book.groupId,
        ]);
      } else {
        await this.database.execute(
          'INSERT INTO settlement_books (id, group_id, version, fee_borne_by) VALUES ($1, $2, $3, $4)',
          [book.bookId, book.groupId, book.version + 1, book.feeBorneBy],
        );
      }
      // Each status a settlement has is a line of its history, written with the fact that moved it (request 19).
      for (const settlement of book.recorded()) {
        await this.database.execute(
          'INSERT INTO settlements (id, group_id, payer, payee, amount, settled, method, status, at, provider_payment_id, pay_url, fee_amount, fee_borne_by, ' +
            'original_currency, original_amount, original_rate) ' +
            'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)',
          [
            settlement.id,
            settlement.groupId,
            settlement.from,
            settlement.to,
            settlement.amount,
            settlement.settled,
            settlement.method,
            settlement.status,
            settlement.at,
            settlement.providerPaymentId ?? null,
            settlement.payUrl ?? null,
            settlement.fee?.amount ?? null,
            settlement.fee?.borneBy ?? null,
            settlement.original?.currency ?? null,
            settlement.original?.amount ?? null,
            settlement.original?.rate ?? null,
          ],
        );
        await this.#history(settlement.id, settlement.status, settlement.at);
      }
      for (const { id, status, at, by } of book.moved()) {
        await this.database.execute('UPDATE settlements SET status = $1 WHERE id = $2', [status, id]);
        await this.#history(id, status, at, by);
      }
      // Every decision of an administrator is an entry of their log, made durable with the decision (request 33).
      for (const entry of book.decisions()) {
        await this.database.execute(
          'INSERT INTO administrator_log (id, at, by_account, action, subject_id) VALUES ($1, $2, $3, $4, $5)',
          [entry.id, entry.at, entry.by, entry.action, entry.subjectId],
        );
      }
    });
  }

  async #history(settlementId: string, status: string, at: string, by?: string): Promise<void> {
    await this.database.execute(
      'INSERT INTO settlement_history (settlement_id, status, at, by_account) VALUES ($1, $2, $3, $4)',
      [settlementId, status, at, by ?? null],
    );
  }

  async absorb(book: SettlementBook, mergedGroupId: string): Promise<void> {
    await this.database.transaction(async () => {
      const stored = await this.database.row<{ version: number }>(
        'SELECT version FROM settlement_books WHERE group_id = $1',
        [book.groupId],
      );
      if ((stored?.version ?? 0) !== book.version) {
        throw new ConcurrencyConflictException('Settlements', 'The settlement book changed since it was read');
      }
      if (stored) {
        await this.database.execute('UPDATE settlement_books SET version = $1 WHERE group_id = $2', [
          book.version + 1,
          book.groupId,
        ]);
      } else {
        await this.database.execute('INSERT INTO settlement_books (id, group_id, version) VALUES ($1, $2, $3)', [
          book.bookId,
          book.groupId,
          book.version + 1,
        ]);
      }
      await this.database.execute('UPDATE settlements SET group_id = $1 WHERE group_id = $2', [
        book.groupId,
        mergedGroupId,
      ]);
      await this.database.execute('DELETE FROM settlement_books WHERE group_id = $1', [mergedGroupId]);
    });
  }

  async settlementOf(id: string): Promise<SettlementView | undefined> {
    const row = await this.database.row<SettlementRow>(`SELECT ${VIEW_COLUMNS} FROM settlements WHERE id = $1`, [id]);
    if (!row) return undefined;
    const history = await this.database.rows<HistoryRow>(
      'SELECT status, at FROM settlement_history WHERE settlement_id = $1 ORDER BY seq',
      [id],
    );
    return toView(row, history);
  }

  async settlementsOf(groupId: string): Promise<SettlementView[]> {
    const rows = await this.database.rows<SettlementRow>(
      `SELECT ${VIEW_COLUMNS} FROM settlements WHERE group_id = $1 ORDER BY at DESC, seq DESC`,
      [groupId],
    );
    const lines = await this.database.rows<HistoryOfGroupRow>(
      `SELECT h.settlement_id, h.status, h.at FROM settlement_history h
         JOIN settlements s ON s.id = h.settlement_id WHERE s.group_id = $1 ORDER BY h.seq`,
      [groupId],
    );
    const historyOf = new Map<string, HistoryRow[]>();
    for (const { settlement_id, status, at } of lines) {
      historyOf.set(settlement_id, [...(historyOf.get(settlement_id) ?? []), { status, at }]);
    }
    return rows.map(row => toView(row, historyOf.get(row.id) ?? []));
  }

  async settledOf(groupId: string): Promise<SettledTransfer[]> {
    const rows = await this.database.rows<{ payer: string; payee: string; settled: number }>(
      `SELECT payer, payee, COALESCE(settled, amount) AS settled FROM settlements WHERE group_id = $1 AND status IN ${COUNTED_STATUSES}`,
      [groupId],
    );
    return rows.map(row => ({ from: row.payer, to: row.payee, amount: row.settled }));
  }

  async countedOf(groupId: string, memberId: string): Promise<CountedSettlement[]> {
    const rows = await this.database.rows<CountedRow>(
      `SELECT s.id, s.payer, s.payee, COALESCE(s.settled, s.amount) AS amount, s.method,
              COALESCE((SELECT h.at FROM settlement_history h
                         WHERE h.settlement_id = s.id AND h.status = 'paid' ORDER BY h.seq LIMIT 1), s.at) AS counted_at
         FROM settlements s
        WHERE s.group_id = $1 AND s.status IN ${COUNTED_STATUSES} AND (s.payer = $2 OR s.payee = $2)
        ORDER BY s.seq`,
      [groupId, memberId],
    );
    return rows.map(row => ({
      id: row.id,
      from: row.payer,
      to: row.payee,
      amount: row.amount,
      method: row.method,
      countedAt: row.counted_at,
    }));
  }

  async feePolicyOf(groupId: string): Promise<FeeBorne> {
    const row = await this.database.row<{ fee_borne_by: string }>(
      'SELECT fee_borne_by FROM settlement_books WHERE group_id = $1',
      [groupId],
    );
    return toFeeBorne(row?.fee_borne_by);
  }

  async hasWaitingPayment(groupId: string, memberId: string): Promise<boolean> {
    const rows = await this.database.rows(
      `SELECT 1 AS waiting FROM settlements
        WHERE group_id = $1 AND method = 'provider' AND status IN ('pending', 'refunding', 'contested') AND (payer = $2 OR payee = $2)
        LIMIT 1`,
      [groupId, memberId],
    );
    return rows.length > 0;
  }

  async auditOf(groupId: string): Promise<SettlementAuditLine[]> {
    const rows = await this.database.rows<AuditRow>(
      `SELECT s.id, s.payer, s.payee, COALESCE(s.settled, s.amount) AS amount, s.method, h.status, h.at, n.asked_by AS netted_by, h.by_account AS decided_by
         FROM settlement_history h JOIN settlements s ON s.id = h.settlement_id
         LEFT JOIN netting_settlements ns ON ns.settlement_id = s.id
         LEFT JOIN nettings n ON n.id = ns.netting_id
        WHERE s.group_id = $1
          AND (h.status IN ('paid', 'contested')
               OR (h.status = 'refunded' AND EXISTS (
                     SELECT 1 FROM settlement_history p WHERE p.settlement_id = h.settlement_id AND p.status = 'paid')))
        ORDER BY h.seq`,
      [groupId],
    );
    return rows.map(row =>
      row.status === 'paid'
        ? {
            // A settlement an administrator decided paid is a second paid line, by that administrator (request 33).
            id: row.decided_by === null ? `${row.id}:paid` : `${row.id}:paid-decided`,
            at: row.at,
            by: row.decided_by ?? byOf(row),
            action: 'settlement-paid',
            subjectId: row.id,
            amount: row.amount,
          }
        : row.status === 'contested'
          ? {
              id: `${row.id}:contested`,
              at: row.at,
              by: row.payee,
              action: 'settlement-contested',
              subjectId: row.id,
              amount: row.amount,
            }
          : {
              id: `${row.id}:refunded`,
              at: row.at,
              by: row.payee,
              action: 'settlement-refunded',
              subjectId: row.id,
              amount: row.amount,
            },
    );
  }

  async nettingOf(id: string): Promise<NettingView | undefined> {
    const row = await this.database.row<NettingRow>(
      'SELECT id, asked_by, asked_with, currency, amount FROM nettings WHERE id = $1',
      [id],
    );
    if (!row) return undefined;
    const settlements = await this.database.rows<{ settlement_id: string }>(
      'SELECT settlement_id FROM netting_settlements WHERE netting_id = $1 ORDER BY seq',
      [id],
    );
    return {
      id: row.id,
      by: row.asked_by,
      with: row.asked_with,
      currency: row.currency,
      amount: row.amount,
      settlements: settlements.map(settlement => settlement.settlement_id),
    };
  }

  async contestedNow(): Promise<SettlementView[]> {
    const rows = await this.database.rows<SettlementRow>(
      `SELECT s.id, s.group_id, s.payer, s.payee, s.amount, s.method, s.status, s.at, s.pay_url, s.fee_amount, s.fee_borne_by,
              s.original_currency, s.original_amount, s.original_rate FROM settlements s
        WHERE s.status = 'contested'
        ORDER BY (SELECT MAX(h.seq) FROM settlement_history h WHERE h.settlement_id = s.id AND h.status = 'contested')`,
    );
    const views: SettlementView[] = [];
    for (const row of rows) {
      const history = await this.database.rows<HistoryRow>(
        'SELECT status, at FROM settlement_history WHERE settlement_id = $1 ORDER BY seq',
        [row.id],
      );
      views.push(toView(row, history));
    }
    return views;
  }

  async administratorDecisions(): Promise<AdministratorDecisionLine[]> {
    const rows = await this.database.rows<AdministratorLogRow>(
      'SELECT id, at, by_account, action, subject_id FROM administrator_log ORDER BY seq',
    );
    return rows.map(row => ({
      id: row.id,
      at: row.at,
      by: row.by_account,
      action: row.action,
      subjectId: row.subject_id,
    }));
  }

  async pendingOf(groupId: string): Promise<PendingTransfer[]> {
    const rows = await this.database.rows<LiveRow>(
      `SELECT ${LIVE_COLUMNS} FROM settlements WHERE group_id = $1 AND status IN ('pending', 'contested')`,
      [groupId],
    );
    return rows.map(row => ({ from: row.payer, to: row.payee, amount: row.settled }));
  }
}

/**
 * Who a settlement's paid line is by in the audit: its payee when it was recorded in cash, who asked the netting when it was made by netting
 * (request 32), otherwise its payer (the one who paid through the provider).
 */
const byOf = (row: AuditRow): string => {
  if (row.method === 'cash') return row.payee;
  if (row.method === 'net' && row.netted_by !== null) return row.netted_by;
  return row.payer;
};

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
  ...(row.fee_amount !== null &&
    row.fee_borne_by !== null && { fee: { amount: row.fee_amount, borneBy: toFeeBorne(row.fee_borne_by) } }),
  ...(row.original_currency !== null &&
    row.original_amount !== null &&
    row.original_rate !== null && {
      original: { currency: row.original_currency, amount: row.original_amount, rate: row.original_rate },
    }),
  history: history.map(({ status, at }) => ({ status, at })),
});

const toPayment = (row: LiveRow): ProviderPayment => ({
  id: row.id,
  from: row.payer,
  to: row.payee,
  amount: row.amount,
  settled: row.settled,
  providerPaymentId: row.provider_payment_id,
  payUrl: row.pay_url,
  status: row.status,
});

/** Who bears the provider's fee as it is stored: the payee when nothing is stored (request 38). */
const toFeeBorne = (stored: string | null | undefined): FeeBorne =>
  stored !== undefined && stored !== null && isFeeBorne(stored) ? stored : DEFAULT_FEE_BORNE;
