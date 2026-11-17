/** One transfer of a suggestion: `from` pays `to` the whole `amount`, which is at least 1. */
export interface Transfer {
  from: string;
  to: string;
  amount: number;
}

/** A member with the balance it has in the group: positive when owed, negative when owing. */
export interface MemberOfBalance {
  memberId: string;
  balance: number;
}

/**
 * The transfers that would bring every balance of a group to 0 (request 11, the storm `suggested-settlements`), made by the
 * stated algorithm, so that every member reading it sees the same transfers:
 *
 * 1. The member who owes the most (the lowest balance) pays the member who is owed the most (the highest balance). Ties go
 *    to whoever joined the group first, which is the order of `members`.
 * 2. The payer pays the smaller of what it owes and what the payee is owed: one transfer, which moves both balances by its
 *    amount; whoever is then at 0 is even.
 * 3. Repeat until every balance is 0.
 *
 * The transfers are returned in the order they were made. There are never more than one fewer than the members whose
 * balance is not 0, and none when every balance is already 0. The function is a pure rule of the balances in join order:
 * it reads no clock, no port and no randomness, and records nothing.
 */
export function suggestedSettlements(members: readonly MemberOfBalance[]): Transfer[] {
  const balances = members.map(({ memberId, balance }) => ({ memberId, balance }));
  const transfers: Transfer[] = [];

  for (;;) {
    // Strict comparisons keep the earliest member of `balances` on a tie: the one who joined first.
    let debtor = -1;
    let creditor = -1;
    balances.forEach((member, index) => {
      if (member.balance < 0 && (debtor < 0 || member.balance < balances[debtor].balance)) debtor = index;
      if (member.balance > 0 && (creditor < 0 || member.balance > balances[creditor].balance)) creditor = index;
    });
    // Balances that add up to 0 owe and are owed alike until all are 0; without both there is nothing to settle.
    if (debtor < 0 || creditor < 0) return transfers;

    const amount = Math.min(-balances[debtor].balance, balances[creditor].balance);
    transfers.push({ from: balances[debtor].memberId, to: balances[creditor].memberId, amount });
    balances[debtor].balance += amount;
    balances[creditor].balance -= amount;
  }
}
