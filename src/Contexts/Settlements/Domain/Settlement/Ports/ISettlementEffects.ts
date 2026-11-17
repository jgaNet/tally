/**
 * What the settlements of a group paid do to each member's balance, read from Settlements' own record (SettledAmounts, ADR 7):
 * a payer's balance goes up by what they paid, a payee's goes down by what they received, so a group's effects add up to 0.
 * Settlements owns the answer; Ledger asks it through its own port and its adapter reads this one. A member with no
 * settlement is absent from the map (0).
 */
export interface ISettlementEffects {
  effectsOf(groupId: string): Promise<Map<string, number>>;
}
