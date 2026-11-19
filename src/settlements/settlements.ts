import { randomUUID } from 'node:crypto';
import { recordAudit } from '../audit/audit';
import { balancesWithPendingOf } from '../balances/balances';
import { type Database, inTransaction } from '../database';
import { requireNotSuspended } from '../admin/suspensions';
import { requireMembership, requireNotArchived } from '../groups/groups';
import type { Currency } from '../groups/validation';
import type { RatesConfig } from '../rates/rates';
import { Refusal } from '../refusal';
import { type SettlementStatus, type StatusEntry, historyOf, recordStatus } from './history';
import type { FeeBearer } from './fees';
import { type SettlementMoneyInput, type SettlementOriginal, priceSettlement } from './money';

/** A settlement as the API answers it. */
export interface Settlement {
  id: string;
  groupId: string;
  /** The account id of the member who paid. */
  from: string;
  /** The account id of the member who was paid, and who recorded a cash settlement. */
  to: string;
  /**
   * The amount asked for, in hundredths of the group's currency: in another currency (see `original`), the original
   * times its rate. What it settles is this, less the part of the provider's fee its payer bears (see `fee`): the
   * balances, the statement and the audit count that.
   */
  amount: number;
  method: 'cash' | 'provider' | 'net';
  /**
   * `pending` only while the provider has not said the payment ended; a cash settlement is `paid`.
   * `refunding` once Tally has asked the provider to refund a paid one, `refunded` once the provider said so.
   * `contested` once its payee says the money did not reach them, until an administrator decides it: `paid`
   * again, or `annulled`.
   */
  status: SettlementStatus;
  /** When it was recorded. */
  at: string;
  /** Every status it has had, the earliest first, each with when Tally learned it. Its last is `status`. */
  history: StatusEntry[];
  /** Through the provider only: the link where the payer pays. */
  payUrl?: string;
  /**
   * Through the provider, asked for once the fee was made a part of it: the fee the provider said when the payment was
   * asked for, and who bore it then, fixed from then on.
   */
  fee?: { amount: number; borneBy: FeeBearer };
  /**
   * Paid in another currency only: what was paid in it, and the rate it was decided at, which it keeps whatever the rates
   * service says later. Its `amount` is the group's currency's, the original times that rate.
   */
  original?: SettlementOriginal;
}

/**
 * Refuses a settlement from `payerId` to `payeeId` of `amount` that the group cannot take. `payeeId`
 * must be a member of `groupId`, or the group is refused as not there. The payer must be a member too,
 * and not the payee. The amount is a whole number, at least 1, and at most what the payer still owes
 * and at most what the payee is still owed. A payment waiting at the provider counts as paid here, so
 * it cannot be paid twice; a failed or a refunded one does not count at all.
 */
export async function checkNewSettlement(
  db: Database,
  groupId: string,
  payerId: string,
  payeeId: string,
  amount: number,
): Promise<void> {
  await requireMembership(db, groupId, payeeId);
  await requireNotArchived(db, groupId);

  const balances = await balancesWithPendingOf(db, groupId);
  const payer = balances.find(entry => entry.memberId === payerId);
  if (payer === undefined) {
    throw new Refusal(422, 'NotAMember', 'The member who paid must be a member of the group.');
  }
  if (payerId === payeeId) {
    throw new Refusal(422, 'SettlementToSelf', 'A settlement is paid by one member to another, not to oneself.');
  }
  if (!Number.isInteger(amount) || amount < 1) {
    throw new Refusal(422, 'InvalidAmount', 'The amount must be a whole number, at least 1.');
  }

  const payee = balances.find(entry => entry.memberId === payeeId)?.balance ?? 0;
  const owedByPayer = -payer.balance;
  if (amount > owedByPayer || amount > payee) {
    throw new Refusal(
      409,
      'MoreThanIsOwed',
      'The amount is more than the payer owes, or more than the payee is owed: read the balances and decide again.',
    );
  }
}

/**
 * Records that `input.from` paid `payeeId` in cash, `input.money` (in the group's currency, or in another at the rate
 * offered today, see `priceSettlement`), and answers its id. The rules are those of `checkNewSettlement`, applied to
 * the amount in the group's currency; otherwise it is refused and nothing is written, and the rates service is not asked
 * for a settlement that is refused before it.
 *
 * The rate is asked outside the transaction, since the rates service is slow. The balances are read and the settlement
 * written in one transaction, so two settlements recorded at once are decided one after the other: the second sees the
 * first, and one of them is refused when together they would pay more than is owed.
 */
export async function recordCashSettlement(
  db: Database,
  rates: RatesConfig,
  groupId: string,
  payeeId: string,
  input: { from: string; money: SettlementMoneyInput },
): Promise<string> {
  const group = await requireMembership(db, groupId, payeeId);
  await requireNotSuspended(db, payeeId);
  await requireNotArchived(db, groupId);
  const priced = await priceSettlement(rates, group.currency, input.money);
  return inTransaction(db, async () => {
    await requireMembership(db, groupId, payeeId);
    await requireNotSuspended(db, payeeId);
    await checkNewSettlement(db, groupId, input.from, payeeId, priced.amount);
    const id = randomUUID();
    const at = new Date().toISOString();
    await db.execute(
      `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at,
                                original_currency, original_amount, original_rate)
       VALUES (?, ?, ?, ?, ?, 'cash', 'paid', ?, ?, ?, ?)`,
      [id, groupId, input.from, payeeId, priced.amount, at, ...originalColumns(priced.original)],
    );
    await recordStatus(db, id, 'paid', at);
    // A cash settlement starts to count at once, and its payee is the one who recorded it.
    await recordAudit(
      db,
      groupId,
      { by: payeeId, action: 'settlement-paid', subjectId: id, amount: priced.amount },
      at,
    );
    return id;
  });
}

/** The three columns of a settlement's original, as they are written: all null for one in the group's currency. */
export function originalColumns(
  original: SettlementOriginal | undefined,
): [string | null, number | null, string | null] {
  return original === undefined ? [null, null, null] : [original.currency, original.amount, original.rate];
}

interface SettlementRow {
  id: string;
  group_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  method: 'cash' | 'provider' | 'net';
  status: SettlementStatus;
  pay_url: string | null;
  fee_amount: number | null;
  fee_borne_by: FeeBearer | null;
  original_currency: Currency | null;
  original_amount: number | null;
  original_rate: string | null;
  created_at: string;
}

const SETTLEMENT_COLUMNS = `settlements.id, settlements.group_id, settlements.payer_id, settlements.payee_id,
  settlements.amount, settlements.method, settlements.status, settlements.pay_url, settlements.fee_amount,
  settlements.fee_borne_by, settlements.original_currency, settlements.original_amount, settlements.original_rate,
  settlements.created_at`;

/** The settlement as the API answers it, with its history. */
async function settlementOf(db: Database, row: SettlementRow): Promise<Settlement> {
  const settlement: Settlement = {
    id: row.id,
    groupId: row.group_id,
    from: row.payer_id,
    to: row.payee_id,
    amount: row.amount,
    method: row.method,
    status: row.status,
    at: row.created_at,
    history: await historyOf(db, row.id),
  };
  if (row.pay_url !== null) {
    settlement.payUrl = row.pay_url;
  }
  if (row.fee_amount !== null && row.fee_borne_by !== null) {
    settlement.fee = { amount: row.fee_amount, borneBy: row.fee_borne_by };
  }
  if (row.original_currency !== null) {
    settlement.original = {
      currency: row.original_currency,
      amount: row.original_amount as number,
      rate: row.original_rate as string,
    };
  }
  return settlement;
}

/** What the settlement `settlementId` settles: its amount, less the part of the provider's fee its payer bears. */
export async function settledAmountOf(db: Database, settlementId: string): Promise<number> {
  const row = await db.row<{ settled_amount: number }>('SELECT settled_amount FROM settlements WHERE id = ?', [
    settlementId,
  ]);
  return (row as { settled_amount: number }).settled_amount;
}

/**
 * The settlement with this id, for a member of its group. For anyone else it is `undefined`, the same
 * as a settlement that does not exist. Reading it changes nothing.
 */
export async function findSettlement(
  db: Database,
  settlementId: string,
  accountId: string,
): Promise<Settlement | undefined> {
  const row = await db.row<SettlementRow>(
    `SELECT ${SETTLEMENT_COLUMNS}
       FROM settlements JOIN memberships ON memberships.group_id = settlements.group_id
      WHERE settlements.id = ? AND memberships.account_id = ?`,
    [settlementId, accountId],
  );
  return row === undefined ? undefined : settlementOf(db, row);
}

/**
 * Every settlement of `groupId`, the most recently recorded first, each as `findSettlement` answers it.
 * It does not check who asks: the caller must be a member.
 */
export async function settlementsOfGroup(db: Database, groupId: string): Promise<Settlement[]> {
  const rows = await db.rows<SettlementRow>(
    `SELECT ${SETTLEMENT_COLUMNS}
       FROM settlements
      WHERE settlements.group_id = ?
      ORDER BY settlements.created_at DESC, settlements.seq DESC`,
    [groupId],
  );
  const settlements: Settlement[] = [];
  for (const row of rows) {
    settlements.push(await settlementOf(db, row));
  }
  return settlements;
}

/**
 * Every settlement contested now, the earliest contested first, each as `findSettlement` answers it. It does not check
 * who asks: the caller must be an administrator.
 */
export async function contestedSettlements(db: Database): Promise<Settlement[]> {
  const rows = await db.rows<SettlementRow>(
    `SELECT ${SETTLEMENT_COLUMNS}
       FROM settlements
       JOIN settlement_statuses AS contests
         ON contests.settlement_id = settlements.id AND contests.status = 'contested'
      WHERE settlements.status = 'contested'
      ORDER BY contests.at, contests.id`,
  );
  const settlements: Settlement[] = [];
  for (const row of rows) {
    settlements.push(await settlementOf(db, row));
  }
  return settlements;
}

/** The settlement, for a member of its group. Anyone else is refused with `404`, as if it did not exist. */
export async function requireSettlement(db: Database, settlementId: string, accountId: string): Promise<Settlement> {
  const settlement = await findSettlement(db, settlementId, accountId);
  if (!settlement) {
    throw new Refusal(404, 'NotFound', 'There is no such settlement.');
  }
  return settlement;
}
