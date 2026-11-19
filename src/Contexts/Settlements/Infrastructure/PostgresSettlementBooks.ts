import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase, Setup } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { SettlementMethod, SettlementStatus, SettlementView } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import {
  PaidSettlement,
  PendingSettlement,
  SettlementBook,
} from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { ISettlementBooks } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBooks';
import { FeeBorne } from '@Contexts/Settlements/Domain/Settlement/ProviderFee';

/**
 * The tables of the settlements: a group's book is a row holding its version, and each settlement is a row of its own. The
 * book's row is what a save checks (docs/adr/0013); a settlement is changed only by its status: pending to paid or failed, paid to
 * refunding, and to refunded (requests 13 and 15). A settlement through the provider keeps the link its payer pays at and the
 * provider's id for its payment, which its webhook names. `seq` numbers the rows in the order they were stored, as SQLite's rowid did.
 */
export const prepareSettlementSchema: Setup = async database => {
  await database.exec(
    'CREATE TABLE IF NOT EXISTS settlement_books (group_id TEXT PRIMARY KEY, version INTEGER NOT NULL)',
  );
  await database.exec(
    'CREATE TABLE IF NOT EXISTS settlements (seq BIGSERIAL NOT NULL UNIQUE, id TEXT PRIMARY KEY, group_id TEXT NOT NULL, payer_id TEXT NOT NULL, payee_id TEXT NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL, recorded_at TEXT NOT NULL, pay_url TEXT, provider_payment_id TEXT)',
  );
  await database.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS settlements_by_provider_payment ON settlements (provider_payment_id)',
  );
  // Who bears the provider's fee, as the owner decided it, on the group's book (request 38, docs/adr/0037): none until it is decided.
  await database.exec('ALTER TABLE settlement_books ADD COLUMN IF NOT EXISTS fee_borne_by TEXT');
  // What a settlement settles, and the fee it was asked with and who bore it (request 38): all null for one from before, which settles its
  // amount and has no fee.
  await database.exec('ALTER TABLE settlements ADD COLUMN IF NOT EXISTS settled INTEGER');
  await database.exec('ALTER TABLE settlements ADD COLUMN IF NOT EXISTS fee_amount INTEGER');
  await database.exec('ALTER TABLE settlements ADD COLUMN IF NOT EXISTS fee_borne_by TEXT');
  // Each status a settlement has had, in the order the book recorded it, and when Tally learned it (request 19). Written by the book's
  // save, in its transaction.
  await database.exec(
    'CREATE TABLE IF NOT EXISTS settlement_statuses (seq BIGSERIAL NOT NULL UNIQUE, settlement_id TEXT NOT NULL, status TEXT NOT NULL, learned_at TEXT NOT NULL)',
  );
  await database.exec(
    'CREATE INDEX IF NOT EXISTS settlement_statuses_by_settlement ON settlement_statuses (settlement_id)',
  );
  // The group's audit of the changes of money the book makes, one row each, never changed (request 28, docs/adr/0027).
  await database.exec(
    'CREATE TABLE IF NOT EXISTS settlement_audit (seq BIGSERIAL NOT NULL UNIQUE, id TEXT PRIMARY KEY, group_id TEXT NOT NULL, at TEXT NOT NULL, by_id TEXT NOT NULL, action TEXT NOT NULL, subject_id TEXT NOT NULL, amount INTEGER NOT NULL)',
  );
  // The administrators' log of their decisions on contested settlements, one row each, never changed, written with the decision (request 33,
  // docs/adr/0033). Not per group: Groups reads it whole, for the administrators only.
  await database.exec(
    'CREATE TABLE IF NOT EXISTS administrator_decisions (seq BIGSERIAL NOT NULL UNIQUE, id TEXT PRIMARY KEY, at TEXT NOT NULL, by_id TEXT NOT NULL, action TEXT NOT NULL, subject_id TEXT NOT NULL)',
  );
};

/**
 * The settlement books' store over PostgreSQL (docs/adr/0013, docs/adr/0014). Its methods run inside a transaction: the use case's. A save of
 * a book read at a version another writer has moved past changes nothing and answers a conflict, so the use case re-reads and decides
 * again (CONC-OPTIMISTIC). A group's first settlement inserts its book's row: two first settlements at once meet the same check.
 */
export class PostgresSettlementBooks implements ISettlementBooks {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareSettlementSchema);
  }

  async get(groupId: string): Promise<SettlementBook> {
    this.database.assertInTransaction();
    const row = await this.database.get<{ version: number; fee_borne_by: string | null }>(
      'SELECT version, fee_borne_by FROM settlement_books WHERE group_id = ?',
      [groupId],
    );
    const pending = await this.database.all<PendingRow>(
      'SELECT id, payer_id, payee_id, amount, COALESCE(settled, amount) AS settled, provider_payment_id FROM settlements WHERE group_id = ? AND status = \'pending\' ORDER BY recorded_at COLLATE "C", seq',
      [groupId],
    );
    // A contested settlement is held in the book, as paid by the provider, until an administrator decides it (request 33): whether it was
    // contested before is read from its history, so that it is contested once.
    const paid = await this.database.all<PaidRow>(
      `SELECT id, payer_id, payee_id, amount, COALESCE(settled, amount) AS settled, provider_payment_id, status,
           EXISTS (SELECT 1 FROM settlement_statuses l WHERE l.settlement_id = settlements.id AND l.status = 'contested') AS was_contested
         FROM settlements WHERE group_id = ? AND method = 'provider' AND status IN ('paid', 'refunding', 'contested') ORDER BY recorded_at COLLATE "C", seq`,
      [groupId],
    );
    return SettlementBook.fromSnapshot({
      groupId,
      version: row ? Number(row.version) : 0,
      pending: pending.map(pendingOf),
      paid: paid.map(paidOf),
      feeBorne: row?.fee_borne_by ? (String(row.fee_borne_by) as FeeBorne) : undefined,
    });
  }

  async ofPayment(providerPaymentId: string): Promise<SettlementBook | undefined> {
    this.database.assertInTransaction();
    const row = await this.database.get<{ group_id: string }>(
      'SELECT group_id FROM settlements WHERE provider_payment_id = ?',
      [providerPaymentId],
    );
    return row ? this.get(String(row.group_id)) : undefined;
  }

  async ofSettlement(settlementId: string): Promise<SettlementBook | undefined> {
    this.database.assertInTransaction();
    const row = await this.database.get<{ group_id: string }>('SELECT group_id FROM settlements WHERE id = ?', [
      settlementId,
    ]);
    return row ? this.get(String(row.group_id)) : undefined;
  }

  async moveGroup(fromGroupId: string, intoGroupId: string): Promise<void> {
    this.database.assertInTransaction();
    // The settlements and their audit keep their rows, and so their order (seq); the merged group's book row goes (request 31).
    await this.database.run('UPDATE settlements SET group_id = ? WHERE group_id = ?', [intoGroupId, fromGroupId]);
    await this.database.run('UPDATE settlement_audit SET group_id = ? WHERE group_id = ?', [intoGroupId, fromGroupId]);
    await this.database.run('DELETE FROM settlement_books WHERE group_id = ?', [fromGroupId]);
  }

  async save(book: SettlementBook): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const groupId = book.groupId;
    if (book.version === 0) {
      const { changes } = await this.database.run(
        'INSERT INTO settlement_books (group_id, version) VALUES (?, ?) ON CONFLICT (group_id) DO NOTHING',
        [groupId, 1],
      );
      if (changes === 0) return Result.fail(changedSinceRead());
    } else {
      const { changes } = await this.database.run(
        'UPDATE settlement_books SET version = ? WHERE group_id = ? AND version = ?',
        [book.version + 1, groupId, book.version],
      );
      if (changes === 0) return Result.fail(changedSinceRead());
    }

    // The owner's decision on the provider's fee is written with the book's version, in this transaction (request 38).
    if (book.feeBorneChanged !== undefined) {
      await this.database.run('UPDATE settlement_books SET fee_borne_by = ? WHERE group_id = ?', [
        book.feeBorneChanged,
        groupId,
      ]);
    }

    // Each status the book records is a line of the history, written with the fact, in this transaction (request 19).
    for (const settlement of book.recorded) {
      await this.database.run(
        'INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, recorded_at, pay_url, provider_payment_id, settled, fee_amount, fee_borne_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
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
          settlement.settled,
          settlement.fee?.amount ?? null,
          settlement.fee?.borneBy ?? null,
        ],
      );
      await this.learn(settlement.id, settlement.status, settlement.at);
    }

    for (const each of book.moved) {
      await this.database.run('UPDATE settlements SET status = ? WHERE id = ?', [each.status, each.id]);
      await this.learn(each.id, each.status, each.at);
    }

    // Each administrators' decision is an entry of the log, written with the decision in this transaction (request 33, docs/adr/0033).
    for (const decision of book.decided) {
      await this.database.run(
        'INSERT INTO administrator_decisions (id, at, by_id, action, subject_id) VALUES (?, ?, ?, ?, ?)',
        [decision.id, decision.at, decision.by, decision.action, decision.subjectId],
      );
    }

    // Each change of money the book made is an entry of the group's audit, written with it in this transaction (request 28, docs/adr/0027).
    for (const change of book.audited) {
      await this.database.run(
        'INSERT INTO settlement_audit (id, group_id, at, by_id, action, subject_id, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [change.id, groupId, change.at, change.by, change.action, change.subjectId, change.amount],
      );
    }
    return Result.ok(undefined);
  }

  private async learn(settlementId: string, status: string, learnedAt: string): Promise<void> {
    await this.database.run('INSERT INTO settlement_statuses (settlement_id, status, learned_at) VALUES (?, ?, ?)', [
      settlementId,
      status,
      learnedAt,
    ]);
  }
}

const changedSinceRead = () =>
  new ConcurrencyConflictException('Settlements', 'The settlements of the group changed since they were read');

type PendingRow = {
  id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  settled: number;
  provider_payment_id: string;
};
type PaidRow = PendingRow & { status: string; was_contested: boolean };

const pendingOf = (row: PendingRow): PendingSettlement => ({
  id: String(row.id),
  from: String(row.payer_id),
  to: String(row.payee_id),
  amount: Number(row.amount),
  settled: Number(row.settled),
  providerPaymentId: String(row.provider_payment_id),
});

const paidOf = (row: PaidRow): PaidSettlement => ({
  ...pendingOf(row),
  status: String(row.status) as PaidSettlement['status'],
  wasContested: Boolean(row.was_contested),
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
  fee_amount: number | null;
  fee_borne_by: string | null;
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
  // A settlement through the provider asked since request 38 keeps the fee it was asked with; one from before has none (request 38).
  if (row.fee_amount !== null && row.fee_borne_by !== null) {
    view.fee = { amount: Number(row.fee_amount), borneBy: String(row.fee_borne_by) as FeeBorne };
  }
  return view;
}
