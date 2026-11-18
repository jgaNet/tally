/** A recurring expense as a member of its group reads it: its split as it was given, in the one of its three forms. */
export interface RecurringReadModel {
  id: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  startsOn: string;
  /** The day of the next expense it will record. */
  next: string;
  /** What each of its expenses is filed under (request 24). */
  category: string;
  splitBetween?: string[];
  splitExactly?: { memberId: string; amount: number }[];
  splitByShares?: { memberId: string; shares: number }[];
}
