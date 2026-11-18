/**
 * A template as a member reads it (request 25): its id, group and name, and its split as it was given, equally between members or by
 * shares. Exactly one of the two splits is given.
 */
export interface TemplateReadModel {
  id: string;
  groupId: string;
  name: string;
  splitBetween?: string[];
  splitByShares?: { memberId: string; shares: number }[];
}
