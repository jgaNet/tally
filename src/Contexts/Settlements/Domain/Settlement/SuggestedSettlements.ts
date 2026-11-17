/** A member of a group and their balance: what they owe (negative) or are owed (positive), in the group's currency's hundredths. */
export interface MemberBalance {
  readonly memberId: string;
  readonly balance: number;
}

/** One transfer of a suggestion: `from` pays `to` the amount, in the group's currency's hundredths. */
export interface Transfer {
  readonly from: string;
  readonly to: string;
  readonly amount: number;
}

/**
 * The transfers that would bring every balance to 0, by the stated algorithm of request 11 (a pure function: no port, no clock,
 * no state). The balances come in the order the members joined, the earliest first. Each step: the member who owes the most (the
 * lowest balance) pays the member who is owed the most (the highest balance) the smaller of what the first owes and what the
 * second is owed; both balances move by that amount, and the one now at 0 is even. Where two members owe the same, or are owed
 * the same, the one who joined first is taken. The steps end when every balance is 0, so there are never more transfers than
 * members whose balance is not 0 less one, and the transfers are in the order made.
 */
export function suggestSettlements(balances: readonly MemberBalance[]): Transfer[] {
  const open = balances.map(({ memberId, balance }) => ({ memberId, balance }));
  const transfers: Transfer[] = [];

  for (;;) {
    let debtor = -1;
    let creditor = -1;
    // Strict comparisons keep the member who joined first where two are tied.
    for (let index = 0; index < open.length; index++) {
      if (open[index].balance < 0 && (debtor === -1 || open[index].balance < open[debtor].balance)) debtor = index;
      if (open[index].balance > 0 && (creditor === -1 || open[index].balance > open[creditor].balance))
        creditor = index;
    }
    // Nobody owes or nobody is owed: every balance is 0 (the balances add up to 0 by construction).
    if (debtor === -1 || creditor === -1) return transfers;

    const amount = Math.min(-open[debtor].balance, open[creditor].balance);
    transfers.push({ from: open[debtor].memberId, to: open[creditor].memberId, amount });
    open[debtor].balance += amount;
    open[creditor].balance -= amount;
  }
}
