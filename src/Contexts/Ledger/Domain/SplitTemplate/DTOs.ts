/**
 * How a template splits an expense, as it is saved (request 25): equally between the members listed, or by whole shares of each. The
 * same two shapes an expense's split takes as it is given (`SplitInput`, request 4 and request 7); an exact split is never a template,
 * as its amounts depend on the expense's.
 */
export type TemplateSplit =
  { kind: 'equal'; between: string[] } | { kind: 'shares'; shares: Array<{ memberId: string; shares: number }> };

/** A template as the store keeps it: what `SplitTemplate.fromSnapshot()` reads and `toSnapshot()` writes (request 25, docs/adr/0024). */
export interface SplitTemplateSnapshot {
  id: string;
  groupId: string;
  name: string;
  /** The member who saved it: the one who may replace or remove it, with the group's owner. */
  createdBy: string;
  split: TemplateSplit;
  version: number;
}

/** A template as a member reads it: its split as it was given, under the one of the two names it has (request 25). */
export interface SplitTemplateView {
  id: string;
  groupId: string;
  name: string;
  splitBetween?: string[];
  splitByShares?: Array<{ memberId: string; shares: number }>;
}
