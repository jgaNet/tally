/** A settlement as it is read: what was paid, by whom to whom, how and whether it is paid, and when it was recorded. */
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

/** A settled transfer of a group, as Ledger counts it: what the payer paid the payee. */
export interface SettledTransfer {
  from: string;
  to: string;
  amount: number;
}

/**
 * The read side of the settlements (ADR 11): what a member reads of one settlement, and what was settled in a group, read from
 * Settlements' own store. Ledger reads the second through its `SettledAmounts` port, answered by an adapter over this; Settlements'
 * Domain and Application are the only code that reads the first.
 */
export interface ISettlementQueries {
  /** The settlement with this id, if it is stored. */
  settlementOf(id: string): Promise<SettlementView | undefined>;
  /** Every settlement recorded in the group, in no order: one statement, so it is one state of the group's settlements. */
  settledOf(groupId: string): Promise<SettledTransfer[]>;
}
