/** A settlement as a member reads it: the fields the API answers. */
export interface SettlementView {
  id: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
  method: 'cash';
  status: 'paid';
  at: string;
}

/** A settlement that was paid, as Ledger counts it: who paid whom, and how much. */
export interface PaidSettlement {
  from: string;
  to: string;
  amount: number;
}

/**
 * The read side of settlements: read models, never aggregates (QUERY-READ-MODELS). Ledger reads `paidIn` through its own
 * port when it reads a balance (ADR 8); a settlement is read only by a member of its group, which the handler asks.
 */
export interface ISettlementQueries {
  /** The settlement with this id, or null if there is none. */
  findById(id: string): Promise<SettlementView | null>;
  /** Every settlement of the group that was recorded, in the order they were recorded. */
  paidIn(groupId: string): Promise<PaidSettlement[]>;
}
