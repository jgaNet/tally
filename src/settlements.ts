import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { type Balance, balancesOfGroup } from './balances';
import { findGroupOfMember, membersOfGroup } from './groups';
import { Refusal } from './refusal';
import { inReadSnapshot, inTransaction } from './transactions';

/** One transfer of a suggested settlement: `from` pays `to` the `amount`. The ids are the members' account ids. */
export interface Transfer {
  readonly from: string;
  readonly to: string;
  readonly amount: number;
}

/**
 * The transfers that bring every balance to 0, by this algorithm, so that every member reads the same ones:
 *
 * 1. Start from the balances, in the order the members joined (as {@link balancesOfGroup} gives them).
 * 2. Take the member who owes the most (the lowest balance) and the member who is owed the most (the highest
 *    balance). On a tie, the member who joined first, being first in the order given.
 * 3. The first pays the second the smaller of what the first owes and what the second is owed. That is one
 *    transfer; both balances move by its amount, and whoever is now at 0 is even.
 * 4. Repeat from 2 until every balance is 0.
 *
 * Each transfer zeroes at least one balance, so there are never more transfers than members whose balance is
 * not 0, less one. With every balance already 0 there is none. The input is not changed.
 */
export function suggestTransfers(balances: readonly Balance[]): Transfer[] {
  const remaining = balances.map(balance => ({ memberId: balance.memberId, balance: Number(balance.balance) }));
  const transfers: Transfer[] = [];
  for (;;) {
    let debtor = -1;
    let creditor = -1;
    remaining.forEach((member, index) => {
      // Strict comparisons keep the earliest index on a tie: the member who joined first.
      if (member.balance < 0 && (debtor < 0 || member.balance < remaining[debtor].balance)) debtor = index;
      if (member.balance > 0 && (creditor < 0 || member.balance > remaining[creditor].balance)) creditor = index;
    });
    if (debtor < 0 || creditor < 0) return transfers;
    const amount = Math.min(-remaining[debtor].balance, remaining[creditor].balance);
    transfers.push({ from: remaining[debtor].memberId, to: remaining[creditor].memberId, amount });
    remaining[debtor].balance += amount;
    remaining[creditor].balance -= amount;
  }
}

/**
 * The suggested settlement of a group, read by `readerId`, who must be a current member of the group (else
 * `404`, as if the group did not exist). It reads one consistent state of the file and changes nothing: a
 * suggestion records nothing, and the balances stay what the expenses make them.
 */
export function suggestedSettlement(db: DatabaseSync, readerId: string, groupId: string): Transfer[] {
  return inReadSnapshot(db, () => {
    if (!findGroupOfMember(db, readerId, groupId)) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    return suggestTransfers(balancesOfGroup(db, groupId));
  });
}

/** What the application knows of a settlement, as a member of its group sees it. `at` is when it was recorded. */
export interface Settlement {
  readonly id: string;
  readonly groupId: string;
  /** The member who paid, in cash, the amount to the payee. */
  readonly from: string;
  /** The member who recorded it, and was paid. */
  readonly to: string;
  readonly amount: number;
  readonly method: 'cash';
  readonly status: 'paid';
  readonly at: string;
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

function settlementOf(row: SettlementRow): Settlement {
  return {
    id: row.id,
    groupId: row.group_id,
    from: row.payer_id,
    to: row.payee_id,
    amount: Number(row.amount),
    method: row.method,
    status: row.status,
    at: row.created_at,
  };
}

/**
 * Records that `payerId` paid `payeeId` the `amount` in cash, in the group, and answers its id. The payee
 * is the member who records it. Refused with `404` when the payee is not a member of the group; with `422`
 * when the amount is not a whole number from 1, when the payer is the payee, or when the payer is not a
 * member of the group; with `409` when the amount is more than the payer owes (the opposite of their
 * balance) or more than the payee is owed (their balance), on the balances as they stand. The balances
 * are read and the settlement written in one transaction, so two settlements recorded at once are each
 * decided on the balances the other left: when both would pay more than is owed, one is refused.
 */
export function recordCashSettlement(
  db: DatabaseSync,
  input: { groupId: string; payeeId: string; payerId: string; amount: number },
): string {
  const { groupId, payeeId, payerId, amount } = input;
  const id = randomUUID();
  inTransaction(db, () => {
    if (!findGroupOfMember(db, payeeId, groupId)) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Refusal(422, 'AmountIsInvalid', 'The amount must be a whole number, at least 1.');
    }
    if (payerId === payeeId) {
      throw new Refusal(422, 'PayerIsPayee', 'The member who paid cannot be the member who was paid.');
    }
    if (!membersOfGroup(db, groupId).some(member => member.memberId === payerId)) {
      throw new Refusal(422, 'PayerNotInGroup', 'The payer must be a member of the group.');
    }
    const balances = balancesOfGroup(db, groupId);
    const payerBalance = balances.find(member => member.memberId === payerId)?.balance ?? 0;
    const payeeBalance = balances.find(member => member.memberId === payeeId)?.balance ?? 0;
    const owedByPayer = Math.max(0, -payerBalance);
    const owedToPayee = Math.max(0, payeeBalance);
    if (amount > owedByPayer || amount > owedToPayee) {
      throw new Refusal(
        409,
        'AmountExceedsBalance',
        'The amount must not be more than the payer owes, nor more than the payee is owed.',
      );
    }
    db.prepare(
      'INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, groupId, payerId, payeeId, amount, 'cash', 'paid', new Date().toISOString());
  });
  return id;
}

/**
 * The settlement with this id, when `accountId` is a current member of its group; `undefined` otherwise,
 * as if it did not exist. Reading never changes it.
 */
export function findSettlementOfMember(
  db: DatabaseSync,
  accountId: string,
  settlementId: string,
): Settlement | undefined {
  const row = db
    .prepare(
      `SELECT s.id, s.group_id, s.payer_id, s.payee_id, s.amount, s.method, s.status, s.created_at FROM settlements s
       JOIN group_members m ON m.group_id = s.group_id
       WHERE s.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
    )
    .get(settlementId, accountId) as SettlementRow | undefined;
  return row && settlementOf(row);
}
