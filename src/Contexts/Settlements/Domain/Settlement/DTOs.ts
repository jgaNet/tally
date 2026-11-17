/** How a settlement is paid: in cash, handed over between the two members (request 12), or through the provider (request 13). */
export type SettlementMethod = 'cash' | 'provider';

/**
 * Where a settlement stands: a cash settlement is paid the moment it is recorded (request 12); a settlement through the provider
 * is `pending` until the provider says its payment ended, once: `paid` if it succeeded, `failed` if it did not (request 13). A paid
 * one is `refunding` once its payee asked for the refund, and `refunded` once the provider says it went back (request 15).
 */
export type SettlementStatus = 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded';

/**
 * A settlement as it is recorded and as `GetSettlement` answers it (requests 12 and 13). `from` pays `to`, `at` when it was
 * recorded. A settlement through the provider has its `payUrl`: the link where the payer pays; a cash one has none.
 */
export interface SettlementView {
  id: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
  method: SettlementMethod;
  status: SettlementStatus;
  at: string;
  payUrl?: string;
}

/** One status a settlement has had, and when Tally learned it (request 19). */
export interface SettlementStatusLine {
  status: SettlementStatus;
  at: string;
}

/**
 * A settlement as the queries answer it (request 19): its view, and every status it has had, the earliest first. A status is a line
 * only when the book recorded it: a webhook that changes nothing adds none.
 */
export interface SettlementWithHistory extends SettlementView {
  history: SettlementStatusLine[];
}

/** What one member paid and received in the settlements of a group: their balance moves by `paid` less `received`. */
export interface SettledMember {
  memberId: string;
  paid: number;
  received: number;
}

/**
 * What one member is waiting to pay and to receive in the pending settlements of a group (request 13): not yet in the balances,
 * but counted as if they were, by what a member still owes and what it is still owed.
 */
export interface WaitingMember {
  memberId: string;
  paid: number;
  received: number;
}

/**
 * What a member of a group still owes, counting the payments waiting at the provider as paid (request 18, docs/adr/0018): `amount`
 * is positive, and a member who owes nothing is not listed.
 */
export interface OutstandingDebt {
  groupId: string;
  memberId: string;
  amount: number;
}
