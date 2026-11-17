/**
 * A member of a group and the balance the group's expenses give them: what they owe (negative) or are owed (positive), in
 * the group's currency. The members are given in the order they joined, the first to have joined first.
 */
export interface MemberBalance {
  memberId: string;
  balance: number;
}

/** A transfer the suggestion makes: `from` pays `to` the whole `amount` (at least 1). */
export interface SuggestedTransfer {
  from: string;
  to: string;
  amount: number;
}

/**
 * The transfers that bring every balance to 0 (request 11), by the algorithm the request states, so that every member
 * reading it sees the same transfers:
 *  1. take the member who owes the most (the lowest balance) and the member who is owed the most (the highest balance);
 *     when several owe, or are owed, the same, the one who joined first;
 *  2. the first pays the second the smaller of what the first owes and what the second is owed: one transfer, both
 *     balances move by its amount;
 *  3. repeat until every balance is 0.
 * The transfers are returned in the order they are made; there are never more than one fewer than the members whose
 * balance is not 0, and none when every balance is 0. The balances must add up to 0 (the ledger keeps them so): a group
 * whose balances do not is corrupted, which is a programming error, not a refusal.
 */
export function suggestTransfers(members: readonly MemberBalance[]): SuggestedTransfer[] {
  const balances = members.map(member => member.balance);
  if (balances.reduce((sum, balance) => sum + balance, 0) !== 0) {
    throw new Error('The balances of a group must add up to 0');
  }

  const transfers: SuggestedTransfer[] = [];
  for (;;) {
    const debtor = firstBest(balances, (candidate, best) => candidate < best);
    const creditor = firstBest(balances, (candidate, best) => candidate > best);
    if (debtor === undefined || creditor === undefined || balances[creditor] === 0) return transfers;

    const amount = Math.min(-balances[debtor], balances[creditor]);
    transfers.push({ from: members[debtor].memberId, to: members[creditor].memberId, amount });
    balances[debtor] += amount;
    balances[creditor] -= amount;
  }
}

/** The index of the first balance that `beats` every other one, in the order given (so the earliest on a tie); undefined for none. */
function firstBest(
  balances: readonly number[],
  beats: (candidate: number, best: number) => boolean,
): number | undefined {
  let best: number | undefined;
  balances.forEach((balance, index) => {
    if (best === undefined || beats(balance, balances[best])) best = index;
  });
  return best;
}
