/** What a member reads of a template: its id, its group, its name, and the split as it was given. */
export type TemplateView = { id: string; groupId: string; name: string } & (
  { splitBetween: string[] } | { splitByShares: { memberId: string; shares: number }[] }
);

/** The read side of split templates: a read model, never an aggregate (QUERY-READ-MODELS). Membership is not asked here. */
export interface ISplitTemplateQueries {
  /** The templates of a group, the earliest saved first, each with the split it was given. */
  listGroupTemplates(groupId: string): Promise<TemplateView[]>;
}
