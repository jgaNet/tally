/** A debt watch as the store keeps it: the member and group it is for, since when they have been seen to owe, and when they were last reminded. */
export interface IDebtWatchSnapshot {
  _id: string;
  groupId: string;
  memberId: string;
  /** The instant of the run that first saw the member owing more than 2000, or null while they owe 2000 or less. */
  notedSince: Date | null;
  /** The instant of the last reminder made to them for this group, kept across a debt that clears, or null. */
  lastReminded: Date | null;
  version: number;
}

/** A debt still owed to the group, as the Settlements context answers it for every current member (ADR 10). */
export interface OutstandingDebt {
  groupId: string;
  memberId: string;
  /** What the member still owes, in the group's currency's cents: positive. */
  owes: number;
}
