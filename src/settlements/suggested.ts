import { type Balance, balancesWithPendingOf } from '../balances/balances';
import type { Database } from '../database';

export interface Transfer {
  /** The member who pays. */
  from: string;
  /** The member who is paid. */
  to: string;
  /** In the minor unit of the group's currency; at least 1. */
  amount: number;
}

/**
 * The transfers that bring every balance of `balances` to 0, by the algorithm every member sees:
 *
 *  1. Take the member who owes the most (the lowest balance) and the member who is owed the most
 *     (the highest balance). Where several owe, or are owed, the same, take the one who joined first.
 *  2. The first pays the second the smaller of what the first owes and what the second is owed.
 *     Both balances move by that amount.
 *  3. Repeat until every balance is 0.
 *
 * `balances` are in the order the members joined, the earliest first, as the group's balances are.
 * The transfers are in the order they are made. There are never more than one fewer than the
 * members whose balance is not 0. Pure: it reads its input and changes nothing.
 */
export function suggestedTransfers(balances: readonly Balance[]): Transfer[] {
  const open = balances.map(balance => ({ memberId: balance.memberId, balance: balance.balance }));
  const transfers: Transfer[] = [];

  for (;;) {
    // Strict comparisons keep the earlier member of a tie, as `open` is in the order they joined.
    let debtor = -1;
    let creditor = -1;
    open.forEach((member, index) => {
      if (member.balance < 0 && (debtor < 0 || member.balance < open[debtor].balance)) {
        debtor = index;
      }
      if (member.balance > 0 && (creditor < 0 || member.balance > open[creditor].balance)) {
        creditor = index;
      }
    });
    // Balances that add up to 0 leave a debtor and a creditor for as long as one is not 0.
    if (debtor < 0 || creditor < 0) {
      return transfers;
    }

    const amount = Math.min(-open[debtor].balance, open[creditor].balance);
    transfers.push({ from: open[debtor].memberId, to: open[creditor].memberId, amount });
    open[debtor].balance += amount;
    open[creditor].balance -= amount;
  }
}

/** The suggested transfers of `groupId`, from its balances as they stand. Reading changes nothing. */
export async function suggestedTransfersOf(db: Database, groupId: string): Promise<Transfer[]> {
  return suggestedTransfers(await balancesWithPendingOf(db, groupId));
}
