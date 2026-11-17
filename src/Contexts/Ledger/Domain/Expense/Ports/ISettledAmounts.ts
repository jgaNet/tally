/**
 * What the settlements of a group paid do to each member's balance, as Settlements records them (SettledAmounts, ADR 7):
 * a payer's balance goes up by what they paid, a payee's goes down by what they received. Ledger owns the port and asks it
 * when it reads a balance; its adapter answers it over Settlements' read side. A member with no settlement is absent (0).
 */
export interface ISettledAmounts {
  settledByMember(groupId: string): Promise<Map<string, number>>;
}
