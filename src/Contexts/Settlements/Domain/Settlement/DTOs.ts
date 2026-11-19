import { SettlementFee } from '@Contexts/Settlements/Domain/Settlement/ProviderFee';

/**
 * How a settlement is paid: in cash, handed over between the two members (request 12), through the provider (request 13), or by
 * netting what two members owe each other across their groups (request 32): no money moves, and it counts at once.
 */
export type SettlementMethod = 'cash' | 'provider' | 'net';

/**
 * Where a settlement stands: a cash settlement is paid the moment it is recorded (request 12); a settlement through the provider
 * is `pending` until the provider says its payment ended, once: `paid` if it succeeded, `failed` if it did not (request 13). A paid
 * one is `refunding` once its payee asked for the refund, and `refunded` once the provider says it went back (request 15). A paid
 * one its payee contested is `contested` until an administrator decides it: `paid` again if the money arrived, `annulled` if not (request 33).
 */
export type SettlementStatus = 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded' | 'contested' | 'annulled';

/**
 * A settlement as it is recorded and as `GetSettlement` answers it (requests 12 and 13). `from` pays `to`, `at` when it was
 * recorded. A settlement through the provider has its `payUrl`: the link where the payer pays; a cash one has none. A settlement
 * through the provider asked for since request 38 has its `fee`: what the provider said and who bore it (request 38).
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
  fee?: SettlementFee;
  /** What was paid in another currency, with the rate it was decided at (request 39): absent for one in the group's currency. */
  original?: { currency: string; amount: number; rate: string };
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
 * A settlement that counts in the balances, with the moment the balances started to count it (request 29): a cash one from when it
 * is recorded, one through the provider from when it is paid. A refunded one is not listed.
 */
export interface CountedSettlement {
  settlementId: string;
  payerId: string;
  payeeId: string;
  amount: number;
  method: SettlementMethod;
  /** An instant, ISO 8601 in UTC: the moment the settlement was paid. */
  countedFrom: string;
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

/**
 * One change of money of a group's settlements, as the group's audit keeps it (request 28, docs/adr/0027): a settlement paid, by its payee
 * (in cash) or its payer (through the provider), or refunded by its payee; a settlement contested by its payee, and paid again by an
 * administrator's decision (request 33). `subjectId` is the settlement.
 */
export interface SettlementAuditEntry {
  id: string;
  at: string;
  by: string;
  action: 'settlement-paid' | 'settlement-refunded' | 'settlement-contested';
  subjectId: string;
  amount: number;
}

/**
 * One decision an administrator made on a contested settlement (request 33, docs/adr/0033): `decided-paid` when the money arrived,
 * `decided-annulled` when it did not. Written in the transaction of the decision, never changed, and read by Groups' administrators' log.
 */
export interface AdministratorDecisionEntry {
  id: string;
  at: string;
  by: string;
  action: 'decided-paid' | 'decided-annulled';
  subjectId: string;
}
