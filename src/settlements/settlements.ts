import { randomUUID } from 'node:crypto';
import { balancesWithPendingOf } from '../balances/balances';
import { type Database, inTransaction } from '../database';
import { requireMembership } from '../groups/groups';
import { Refusal } from '../refusal';

/** A settlement as the API answers it. */
export interface Settlement {
  id: string;
  groupId: string;
  /** The account id of the member who paid. */
  from: string;
  /** The account id of the member who was paid, and who recorded a cash settlement. */
  to: string;
  /** In hundredths of the group's currency. */
  amount: number;
  method: 'cash' | 'provider';
  /**
   * `pending` only while the provider has not said the payment ended; a cash settlement is `paid`.
   * `refunding` once Tally has asked the provider to refund a paid one, `refunded` once the provider said so.
   */
  status: 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded';
  /** When it was recorded. */
  at: string;
  /** Through the provider only: the link where the payer pays. */
  payUrl?: string;
}

/**
 * Refuses a settlement from `payerId` to `payeeId` of `amount` that the group cannot take. `payeeId`
 * must be a member of `groupId`, or the group is refused as not there. The payer must be a member too,
 * and not the payee. The amount is a whole number, at least 1, and at most what the payer still owes
 * and at most what the payee is still owed. A payment waiting at the provider counts as paid here, so
 * it cannot be paid twice; a failed or a refunded one does not count at all.
 */
export function checkNewSettlement(
  db: Database,
  groupId: string,
  payerId: string,
  payeeId: string,
  amount: number,
): void {
  requireMembership(db, groupId, payeeId);

  const balances = balancesWithPendingOf(db, groupId);
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
 * Records that `input.from` paid `payeeId` in cash, `input.amount` in hundredths of the group's
 * currency, and answers its id. The rules are those of `checkNewSettlement`; otherwise it is refused
 * and nothing is written.
 *
 * The balances are read and the settlement written in one transaction, so two settlements recorded at
 * once are decided one after the other: the second sees the first, and one of them is refused when
 * together they would pay more than is owed.
 */
export function recordCashSettlement(
  db: Database,
  groupId: string,
  payeeId: string,
  input: { from: string; amount: number },
): string {
  return inTransaction(db, () => {
    checkNewSettlement(db, groupId, input.from, payeeId, input.amount);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'cash', 'paid', ?)`,
    ).run(id, groupId, input.from, payeeId, input.amount, new Date().toISOString());
    return id;
  });
}

interface SettlementRow {
  id: string;
  group_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  method: 'cash' | 'provider';
  status: 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded';
  pay_url: string | null;
  created_at: string;
}

/**
 * The settlement with this id, for a member of its group. For anyone else it is `undefined`, the same
 * as a settlement that does not exist. Reading it changes nothing.
 */
export function findSettlement(db: Database, settlementId: string, accountId: string): Settlement | undefined {
  const row = db
    .prepare(
      `SELECT settlements.id, settlements.group_id, settlements.payer_id, settlements.payee_id,
              settlements.amount, settlements.method, settlements.status, settlements.pay_url,
              settlements.created_at
         FROM settlements JOIN memberships ON memberships.group_id = settlements.group_id
        WHERE settlements.id = ? AND memberships.account_id = ?`,
    )
    .get(settlementId, accountId) as SettlementRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  const settlement: Settlement = {
    id: row.id,
    groupId: row.group_id,
    from: row.payer_id,
    to: row.payee_id,
    amount: row.amount,
    method: row.method,
    status: row.status,
    at: row.created_at,
  };
  if (row.pay_url !== null) {
    settlement.payUrl = row.pay_url;
  }
  return settlement;
}

/** The settlement, for a member of its group. Anyone else is refused with `404`, as if it did not exist. */
export function requireSettlement(db: Database, settlementId: string, accountId: string): Settlement {
  const settlement = findSettlement(db, settlementId, accountId);
  if (!settlement) {
    throw new Refusal(404, 'NotFound', 'There is no such settlement.');
  }
  return settlement;
}
