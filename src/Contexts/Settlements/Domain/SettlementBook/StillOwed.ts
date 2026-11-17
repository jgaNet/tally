/** A transfer that is waiting: `from` pays `to` `amount`, not yet counted by the balances. */
export interface PendingTransfer {
  from: string;
  to: string;
  amount: number;
}

/**
 * What the members still owe, once what is waiting at the provider counts as paid (request 13, ADR 12): a payment pending at
 * the provider moves the payer's balance up by its amount and the payee's down, as a settlement in cash does, and the balances
 * read by the rule, the cash settlement and the suggestions are these. The balances given count only settlements that are paid
 * (`SettledAmounts`); a member not in them is at 0. Each pending transfer moves two balances by the same amount, so the balances
 * still add up to 0.
 */
export function stillOwed(
  balances: ReadonlyMap<string, number>,
  pending: readonly PendingTransfer[],
): ReadonlyMap<string, number> {
  const owed = new Map(balances);
  for (const { from, to, amount } of pending) {
    owed.set(from, (owed.get(from) ?? 0) + amount);
    owed.set(to, (owed.get(to) ?? 0) - amount);
  }
  return owed;
}
