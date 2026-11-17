/** How a settlement is paid: in cash, handed over by its payer, or through the payment provider. */
export type SettlementMethod = 'cash' | 'provider';

/**
 * Where a settlement stands: `pending` while a payment waits at the provider (not counted, but still owed-less), `paid` when
 * it counts, `failed` when the provider said it did not go through (never counted, nothing held). `refunding` is a paid
 * settlement the payee asked the provider to refund: the money has not gone back yet, so it still counts. `refunded` is one
 * the provider says it refunded: it is no longer counted, and it ends there.
 */
export type SettlementStatus = 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded';

/** A settlement as a book records it: the id the domain generated, the group, the payer, the payee, the amount and when. */
export interface ISettlementSnapshot {
  _id: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
  at: string;
  method: SettlementMethod;
  status: SettlementStatus;
  /** The provider's id of the payment, for a settlement through the provider; null in cash. */
  providerPaymentId: string | null;
  /** The provider's payment link, where the payer pays, for a settlement through the provider; null in cash. */
  payUrl: string | null;
}

/** The payment link the provider answers for a payment: its id at the provider and where the payer pays. */
export interface PaymentLink {
  id: string;
  payUrl: string;
}

/**
 * A status a settlement had, and when Tally learned it: the line of a settlement's history (request 19). The time is the clock's
 * at the command that made the status, not the provider's.
 */
export interface ISettlementStatusLine {
  settlementId: string;
  status: SettlementStatus;
  at: string;
}

/** The settlement book as the store keeps it: its identity, its group and the version it was read at. */
export interface ISettlementBookSnapshot {
  _id: string;
  groupId: string;
  version: number;
  /** The settlements decided since the book was read: the store inserts them with the version it moves on. */
  recorded: ISettlementSnapshot[];
  /** The settlements read by the book whose status it moved since: the store updates them with the same version. */
  changed: ISettlementSnapshot[];
  /** The statuses the book gave settlements since it was read, in the order it gave them: the store adds them as history. */
  history: ISettlementStatusLine[];
}
