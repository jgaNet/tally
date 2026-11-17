/** What a member has pending: the amounts it is waiting to pay, and the amounts waiting to be paid to it (docs/adr/0014). */
export interface Waiting {
  paid: number;
  received: number;
}

/**
 * A member's balance once the payments it is waiting on are counted as if they were paid (request 13, docs/adr/0014): what a
 * member still owes is what it owes less what it is waiting to pay, and what it is still owed is what it is owed less what is
 * waiting to be paid to it, never past 0. A member who owes is only moved by what it pays; one who is owed only by what is
 * paid to it. The balances the Ledger reads do not change: a payment counts there once it is paid.
 */
export function stillBalance(balance: number, waiting: Waiting): number {
  return balance < 0 ? Math.min(0, balance + waiting.paid) : Math.max(0, balance - waiting.received);
}
