import { PendingTransfer } from '@Contexts/Settlements/Domain/SettlementBook/StillOwed';
import { FeeBorne } from '@Contexts/Settlements/Domain/SettlementBook/ProviderFee';

/** One status a settlement has had, and when Tally learned it (request 19). */
export interface SettlementHistoryLine {
  status: 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded' | 'contested' | 'annulled';
  at: string;
}

/**
 * A settlement as it is read: what was paid, by whom to whom, how it is paid and where it stands, and when it was recorded. A settlement
 * through the provider also has the link where the payer pays (`payUrl`); one in cash has none (request 13). Its `history` is every
 * status it has had, the earliest first (request 19).
 */
export interface SettlementView {
  id: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
  method: 'cash' | 'provider' | 'net';
  status: 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded' | 'contested' | 'annulled';
  at: string;
  payUrl?: string;
  /** Through the provider, asked for from request 38 on: the fee the provider said and who bore it (request 38). */
  fee?: { amount: number; borneBy: FeeBorne };
  history: SettlementHistoryLine[];
}

/**
 * A change of money a settlement made, as the group's audit reads it (request 28): a settlement paid (by its payer when it went through the
 * provider, by its payee when it was recorded in cash), or refunded (by its payee). `subjectId` is the settlement.
 */
export interface SettlementAuditLine {
  id: string;
  at: string;
  by: string;
  action: 'settlement-paid' | 'settlement-refunded' | 'settlement-contested';
  subjectId: string;
  amount: number;
}

/** An entry of the administrators' log (request 33): which administrator decided what about which settlement, and when. */
export interface AdministratorDecisionLine {
  id: string;
  at: string;
  by: string;
  action: 'decided-paid' | 'decided-annulled';
  subjectId: string;
}

/**
 * A netting as the two people read it (request 32): who asked, with whom, the currency, the amount netted, and the settlements it made, in the
 * order they were made.
 */
export interface NettingView {
  id: string;
  by: string;
  with: string;
  currency: string;
  amount: number;
  settlements: string[];
}

/** A settled transfer of a group, as Ledger counts it: what the payer paid the payee. */
export type SettledTransfer = PendingTransfer;

/**
 * A settlement the balances count, as a member's statement reads it (request 29): who paid whom how much, how it was paid, and when the
 * balances started to count it: the moment it became `paid` (its `paid` line of the history), for a settlement in cash as for one
 * through the provider.
 */
export interface CountedSettlement {
  id: string;
  from: string;
  to: string;
  amount: number;
  method: 'cash' | 'provider' | 'net';
  countedAt: string;
}

/**
 * The read side of the settlements (ADR 11, ADR 12): what a member reads of one settlement, what was settled in a group (paid, as Ledger
 * counts it), and what is waiting at the provider. Ledger reads the second through its `SettledAmounts` port, answered by an adapter over
 * this; Settlements' Domain and Application are the only code that reads the first.
 */
export interface ISettlementQueries {
  /** The settlement with this id, if it is stored. */
  settlementOf(id: string): Promise<SettlementView | undefined>;
  /** Who bears the provider's fee in the group: the payee until its owner decides otherwise (request 38). */
  feePolicyOf(groupId: string): Promise<FeeBorne>;
  /** The netting with this id, if it is stored; the use case answers it only to the two people it is between (request 32). */
  nettingOf(id: string): Promise<NettingView | undefined>;
  /** Every settlement of the group, the most recently recorded first (request 19). */
  settlementsOf(groupId: string): Promise<SettlementView[]>;
  /**
   * Every settlement counted in the group, in no order: paid, and being refunded (the money has not gone back yet, request 15), each
   * counted at what it settles (request 38). One statement, so it is one state of the group's counted settlements.
   */
  settledOf(groupId: string): Promise<SettledTransfer[]>;
  /**
   * Every settlement counted in the group in which the member is the payer or the payee, in no order, each with when the balances
   * started to count it (request 29). The same state of the group's counted settlements as `settledOf`, in one statement.
   */
  countedOf(groupId: string, memberId: string): Promise<CountedSettlement[]>;
  /**
   * The changes of money the group's settlements made (request 28), in the order they were made: each time a settlement became paid, and
   * each time one that had been paid became refunded. Read from the statuses they had, which are written with the change that moved them, so
   * a settlement that was never paid (one refunded while pending) has no entry of its refund.
   */
  auditOf(groupId: string): Promise<SettlementAuditLine[]>;
  /**
   * Every settlement contested now, the earliest contested first, as `settlementOf` reads each (request 33): what an administrator decides.
   */
  contestedNow(): Promise<SettlementView[]>;
  /** The administrators' log, the oldest entry first (request 33). */
  administratorDecisions(): Promise<AdministratorDecisionLine[]>;
  /**
   * Every payment waiting in the group, in no order: pending at the provider, or contested and held until an administrator decides; what is
   * still owed counts them as paid (ADR 12, request 33).
   */
  pendingOf(groupId: string): Promise<PendingTransfer[]>;
  /**
   * Whether a payment through the provider of the member, as payer or payee, is waiting, pending or being refunded, or contested, in the group: a
   * member with one cannot leave the group (request 20, ADR 16, request 33).
   */
  hasWaitingPayment(groupId: string, memberId: string): Promise<boolean>;
}
