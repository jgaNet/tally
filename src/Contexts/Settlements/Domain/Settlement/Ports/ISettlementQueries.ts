/** A settlement as a member reads it: the fields the API answers. `payUrl` is the link of a settlement through the provider only. */
export interface SettlementView {
  id: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
  method: 'cash' | 'provider';
  status: 'paid' | 'pending' | 'failed';
  at: string;
  payUrl?: string;
}

/** A settlement that was paid, as Ledger counts it: who paid whom, and how much. */
export interface PaidSettlement {
  from: string;
  to: string;
  amount: number;
}

/** A payment through the provider waiting for the provider to say how it ended: what is still owed counts it as paid. */
export interface WaitingSettlement {
  from: string;
  to: string;
  amount: number;
}

/**
 * The read side of settlements: read models, never aggregates (QUERY-READ-MODELS). Ledger reads `paidIn` through its own
 * port when it reads a balance (ADR 8), and Settlements reads `waitingIn` when it suggests transfers; a settlement is read
 * only by a member of its group, which the handler asks.
 */
export interface ISettlementQueries {
  /** The settlement with this id, or null if there is none. */
  findById(id: string): Promise<SettlementView | null>;
  /** Every settlement of the group that is paid, in the order they were recorded. */
  paidIn(groupId: string): Promise<PaidSettlement[]>;
  /** Every payment of the group that waits at the provider, in the order they were requested. */
  waitingIn(groupId: string): Promise<WaitingSettlement[]>;
}
