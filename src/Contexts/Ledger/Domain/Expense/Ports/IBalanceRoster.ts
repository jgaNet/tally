/**
 * The balances of a group's members, as Ledger's read model gives them (ADR 1, T4 and T5): what each member owes or is owed, in
 * the group's currency's hundredths, read from the balance rows the expenses wrote. It answers a member nothing has counted 0.
 * It is the read-model port Groups reads through an adapter of its own, when a member asks to leave a group (feature 9): no
 * domain imports another context.
 */
export interface IBalanceRoster {
  balanceOf(groupId: string, memberId: string): Promise<number>;
  /**
   * Every member the group's expenses have counted, with their balance, in no particular order: a member nothing has counted is
   * absent (the reader gives it 0), and the order of the members is the reader's to give. Read in one snapshot, so the balances
   * of one answer add up to 0 even while expenses are being recorded (feature 11: the suggested settlements read them together).
   */
  balancesOf(groupId: string): Promise<RosterBalance[]>;
}

/** A member's balance as the read model answers it: what the member owes (negative) or is owed (positive), in hundredths. */
export interface RosterBalance {
  readonly memberId: string;
  readonly balance: number;
}
