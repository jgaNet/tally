/** What has been settled for one member of a group: the change the group's settlements make to the member's balance. */
export interface SettledAmount {
  memberId: string;
  /** Positive when the member paid settlements (their balance goes up), negative when they received some. */
  amount: number;
}

/**
 * Ledger's port to Settlements, which Ledger owns (ADR 7): what has been settled in a group, per member, read when a balance
 * is read, so that a balance counts a settlement as soon as it is recorded, with no copy of it here. Answered by an adapter
 * over Settlements' read model.
 */
export interface ISettledAmounts {
  settledOf(groupId: string): Promise<SettledAmount[]>;
}
