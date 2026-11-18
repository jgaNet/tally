/** A member a template's split names, with the shares it gives them, as a split by shares is given (request 25). */
export interface TemplateShareView {
  memberId: string;
  shares: number;
}

/**
 * A template as `GetGroupTemplates` answers it (request 25): its id, group and name, and its split as it was given, either the members
 * of an equal split or the shares of a split by shares.
 */
export type TemplateView =
  | { id: string; groupId: string; name: string; splitBetween: string[] }
  | { id: string; groupId: string; name: string; splitByShares: TemplateShareView[] };

/** The read side of the templates: read models, never aggregates (QUERY-READ-MODELS). */
export interface ISplitTemplateQueries {
  /** The templates of the group, the earliest saved first. */
  templatesOf(groupId: string): Promise<TemplateView[]>;
}
