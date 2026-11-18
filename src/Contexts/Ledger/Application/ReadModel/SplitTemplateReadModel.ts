/** A template as a member reads it: its id, its group, its name, and its split as it was given (request 25). */
export type SplitTemplateReadModel = {
  id: string;
  groupId: string;
  name: string;
} & ({ splitBetween: string[] } | { splitByShares: { memberId: string; shares: number }[] });
