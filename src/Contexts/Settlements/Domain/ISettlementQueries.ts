import { PendingTransfer } from '@Contexts/Settlements/Domain/SettlementBook/StillOwed';

/** One status a settlement has had, and when Tally learned it (request 19). */
export interface SettlementHistoryLine {
  status: 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded';
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
  method: 'cash' | 'provider';
  status: 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded';
  at: string;
  payUrl?: string;
  history: SettlementHistoryLine[];
}

/** A settled transfer of a group, as Ledger counts it: what the payer paid the payee. */
export type SettledTransfer = PendingTransfer;

/**
 * The read side of the settlements (ADR 11, ADR 12): what a member reads of one settlement, what was settled in a group (paid, as Ledger
 * counts it), and what is waiting at the provider. Ledger reads the second through its `SettledAmounts` port, answered by an adapter over
 * this; Settlements' Domain and Application are the only code that reads the first.
 */
export interface ISettlementQueries {
  /** The settlement with this id, if it is stored. */
  settlementOf(id: string): Promise<SettlementView | undefined>;
  /** Every settlement of the group, the most recently recorded first (request 19). */
  settlementsOf(groupId: string): Promise<SettlementView[]>;
  /**
   * Every settlement counted in the group, in no order: paid, and being refunded (the money has not gone back yet, request 15). One
   * statement, so it is one state of the group's counted settlements.
   */
  settledOf(groupId: string): Promise<SettledTransfer[]>;
  /** Every payment waiting at the provider in the group, in no order: what is still owed counts them as paid (ADR 12). */
  pendingOf(groupId: string): Promise<PendingTransfer[]>;
}
