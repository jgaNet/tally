/** One member of a group, as the suggestion reads them: their balance (what they owe is negative, what they are owed positive). */
export interface MemberBalance {
  memberId: string;
  balance: number;
}

/** One transfer of the suggestion: `from` pays `to` the `amount`. */
export interface Transfer {
  from: string;
  to: string;
  amount: number;
}

/**
 * The transfers that bring every balance of a group to 0, by the algorithm the product states, so that every member
 * reading it sees the same transfers (feature 11):
 *
 *   1. start from the balances;
 *   2. take the member who owes the most (the lowest balance) and the member who is owed the most (the highest);
 *      on a tie, the one who joined first, which is the earlier index of `members`;
 *   3. the first pays the second the smaller of what the first owes and what the second is owed: one transfer,
 *      which moves both balances by its amount;
 *   4. repeat from 2 until every balance is 0.
 *
 * `members` is in the order they joined, the earliest first, every member of the group once. The transfers are
 * returned in the order they were made; there are never more than one fewer than the members whose balance is not 0,
 * since each transfer leaves at least one of its two balances at 0. When every balance is 0, there is none.
 *
 * It is a pure rule over the balances a group has: nothing is recorded and no fact is published.
 * The balances must add up to 0, as Ledger keeps them; if they do not, the ledger is corrupted and this throws.
 */
export function suggestSettlements(members: MemberBalance[]): Transfer[] {
  const total = members.reduce((sum, member) => sum + member.balance, 0);
  if (total !== 0) throw new Error(`The balances of a group add up to ${total}, not 0: the ledger is corrupted`);

  const balances = members.map(member => ({ ...member }));
  const transfers: Transfer[] = [];
  for (;;) {
    let debtor = -1;
    let creditor = -1;
    balances.forEach((member, index) => {
      if (member.balance < 0 && (debtor < 0 || member.balance < balances[debtor].balance)) debtor = index;
      if (member.balance > 0 && (creditor < 0 || member.balance > balances[creditor].balance)) creditor = index;
    });
    if (debtor < 0 || creditor < 0) return transfers;

    const amount = Math.min(-balances[debtor].balance, balances[creditor].balance);
    transfers.push({ from: balances[debtor].memberId, to: balances[creditor].memberId, amount });
    balances[debtor].balance += amount;
    balances[creditor].balance -= amount;
  }
}
