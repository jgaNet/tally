/**
 * One member's balance in a group, as the suggestion reads it: positive when the group owes the member, negative when the
 * member owes it, 0 when it is even. The balances are given in the order the members joined, the earliest first.
 */
export interface MemberBalance {
  memberId: string;
  balance: number;
}

/** A transfer a member makes to another: from a member who owes to a member who is owed, of a whole positive amount. */
export interface Transfer {
  from: string;
  to: string;
  amount: number;
}

/**
 * The transfers that bring every balance to 0 (request 11), made by a stated algorithm so that every member reads the same
 * ones. Repeatedly: the member who owes the most (the lowest balance) pays the member who is owed the most (the highest
 * balance) the smaller of what the first owes and what the second is owed. Ties go to whoever joined first. Each transfer
 * makes at least one balance 0, so there are never more transfers than the members not even, less one. When every balance
 * is already 0 there is none.
 *
 * It is a suggestion only: nothing is recorded, and the balances are what the expenses make them. The balances must add up
 * to 0, which Ledger keeps by construction; a sum that is not 0 is corrupted state, and is refused by throwing.
 */
export function suggestSettlements(balances: readonly MemberBalance[]): Transfer[] {
  const total = balances.reduce((sum, member) => sum + member.balance, 0);
  if (total !== 0) throw new Error(`The balances of a group add up to ${total}, not 0`);

  const left = balances.map(member => ({ ...member }));
  const transfers: Transfer[] = [];

  for (;;) {
    // The strict comparisons keep the earlier member on a tie: the one who joined first.
    let debtor = 0;
    let creditor = 0;
    for (let index = 1; index < left.length; index++) {
      if (left[index].balance < left[debtor].balance) debtor = index;
      if (left[index].balance > left[creditor].balance) creditor = index;
    }
    // With the balances adding up to 0, a lowest balance of 0 or more means every balance is 0.
    if (left.length === 0 || left[debtor].balance >= 0) return transfers;

    const amount = Math.min(-left[debtor].balance, left[creditor].balance);
    transfers.push({ from: left[debtor].memberId, to: left[creditor].memberId, amount });
    left[debtor].balance += amount;
    left[creditor].balance -= amount;
  }
}
