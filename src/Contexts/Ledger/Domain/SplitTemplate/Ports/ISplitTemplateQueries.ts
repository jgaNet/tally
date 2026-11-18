import { SplitTemplateView } from '@Contexts/Ledger/Domain/SplitTemplate/DTOs';

/** The read side of the split templates: what the queries answer, read at once (request 25). */
export interface ISplitTemplateQueries {
  /** The group's templates, the earliest saved first, each with its split as it was given. */
  listOf(groupId: string): Promise<SplitTemplateView[]>;
}
