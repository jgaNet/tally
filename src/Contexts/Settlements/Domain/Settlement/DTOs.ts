/** How a settlement is paid: in cash, through the provider, or netted between two people across their groups (request 32). */
export type SettlementMethod = 'cash' | 'provider' | 'net';

/**
 * Where a settlement stands: `pending` while a payment waits at the provider (not counted, but still owed-less), `paid` when
 * it counts, `failed` when the provider said it did not go through (never counted, nothing held). `refunding` is a paid
 * settlement the payee asked the provider to refund: the money has not gone back yet, so it still counts. `refunded` is one
 * the provider says it refunded: it is no longer counted, and it ends there. `contested` is a paid settlement its payee says
 * never reached them (request 33): the balances do not count it, what is still owed does, until an administrator decides it was
 * paid again, or `annulled`: counted by nothing, and no longer waiting.
 */
export type SettlementStatus = 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded' | 'contested' | 'annulled';

/** Who bears the provider's fee of a group's payments (request 38): the payer, the payee, or both, shared. */
export type FeeBorneBy = 'payer' | 'payee' | 'shared';

/** The provider's fee of a settlement through the provider, and who bore it, both fixed when the payment was asked for (request 38). */
export interface SettlementFee {
  amount: number;
  borneBy: FeeBorneBy;
}

/** A settlement as a book records it: the id the domain generated, the group, the payer, the payee, the amount and when. */
export interface ISettlementSnapshot {
  _id: string;
  groupId: string;
  from: string;
  to: string;
  /** The amount asked for: what the payer pays the payee, and what the provider is asked for (request 13). */
  amount: number;
  /**
   * What the settlement settles: its amount less the part of the provider's fee its payer bears (request 38). What the balances
   * count, what is still owed while it waits, and what the audit says; the amount when the payer bears none of the fee.
   */
  settled: number;
  /** The provider's fee and who bore it, for a settlement through the provider asked from request 38 on; null otherwise. */
  fee: SettlementFee | null;
  at: string;
  method: SettlementMethod;
  status: SettlementStatus;
  /** The provider's id of the payment, for a settlement through the provider; null in cash. */
  providerPaymentId: string | null;
  /** The provider's payment link, where the payer pays, for a settlement through the provider; null in cash. */
  payUrl: string | null;
  /** Whether the settlement has been contested, whatever it became since: a settlement is contested once (request 33). */
  contested: boolean;
  /** What was paid in another currency, and the rate it was decided at (request 39); null when paid in the group's currency. */
  original: OriginalSnapshot | null;
}

/** What a settlement was paid in another currency: the currency, the amount in its hundredths, and the rate as the rates service wrote it. */
export interface OriginalSnapshot {
  currency: string;
  amount: number;
  rate: string;
}

/**
 * The payment link the provider answers for a payment: its id at the provider, where the payer pays, and the provider's fee in the
 * hundredths of the payment's currency (request 38).
 */
export interface PaymentLink {
  id: string;
  payUrl: string;
  fee: number;
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
  /** The settlements of a merged group the book took up since it was read: the store moves them to this group (request 31). */
  moved: ISettlementSnapshot[];
  /** Who bears the group's provider fee, when the owner set it since the book was read: the store writes it (request 38). */
  feeBorneBy: FeeBorneBy | null;
  /** The administrators' decisions made since the book was read, in the order they were made: the store appends them to the log (request 33). */
  decisions: AdminLogEntry[];
}

/** An entry of the administrators' log: every decision of an administrator, written in the transaction of the decision, never changed (request 33). */
export interface AdminLogEntry {
  id: string;
  at: string;
  by: string;
  action: 'decided-paid' | 'decided-annulled';
  subjectId: string;
}
