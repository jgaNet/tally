import { randomUUID } from 'node:crypto';
import { balancesOf } from '../balances/balances';
import { type Database, inTransaction } from '../database';
import { requireMembership } from '../groups/groups';
import { Refusal } from '../refusal';

/** A settlement as the API answers it. */
export interface Settlement {
  id: string;
  groupId: string;
  /** The account id of the member who paid. */
  from: string;
  /** The account id of the member who was paid, and who recorded the settlement. */
  to: string;
  /** In hundredths of the group's currency. */
  amount: number;
  method: 'cash';
  status: 'paid';
  /** When it was recorded. */
  at: string;
}

export interface CashSettlementInput {
  /** The account id of the member who paid. */
  from: string;
  /** In hundredths of the group's currency. */
  amount: number;
}

/**
 * Records that `input.from` paid `payeeId` in cash, `input.amount` in hundredths of the group's
 * currency, and answers its id. `payeeId` must be a member of `groupId`, or the group is refused as
 * not there. The payer must be a member too, and not the payee. The amount is a whole number, at
 * least 1, and at most what the payer owes and at most what the payee is owed, by the balances as
 * they stand when it is recorded; otherwise it is refused and nothing is written.
 *
 * The balances are read and the settlement written in one transaction, so two settlements recorded at
 * once are decided one after the other: the second sees the first, and one of them is refused when
 * together they would pay more than is owed.
 */
export function recordCashSettlement(
  db: Database,
  groupId: string,
  payeeId: string,
  input: CashSettlementInput,
): string {
  return inTransaction(db, () => {
    requireMembership(db, groupId, payeeId);
    const { from, amount } = input;

    const balances = balancesOf(db, groupId);
    const payer = balances.find(entry => entry.memberId === from);
    if (payer === undefined) {
      throw new Refusal(422, 'NotAMember', 'The member who paid must be a member of the group.');
    }
    if (from === payeeId) {
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

    const id = randomUUID();
    db.prepare(
      `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'cash', 'paid', ?)`,
    ).run(id, groupId, from, payeeId, amount, new Date().toISOString());
    return id;
  });
}

interface SettlementRow {
  id: string;
  group_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  method: 'cash';
  status: 'paid';
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
              settlements.amount, settlements.method, settlements.status, settlements.created_at
         FROM settlements JOIN memberships ON memberships.group_id = settlements.group_id
        WHERE settlements.id = ? AND memberships.account_id = ?`,
    )
    .get(settlementId, accountId) as SettlementRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    id: row.id,
    groupId: row.group_id,
    from: row.payer_id,
    to: row.payee_id,
    amount: row.amount,
    method: row.method,
    status: row.status,
    at: row.created_at,
  };
}

/** The settlement, for a member of its group. Anyone else is refused with `404`, as if it did not exist. */
export function requireSettlement(db: Database, settlementId: string, accountId: string): Settlement {
  const settlement = findSettlement(db, settlementId, accountId);
  if (!settlement) {
    throw new Refusal(404, 'NotFound', 'There is no such settlement.');
  }
  return settlement;
}
