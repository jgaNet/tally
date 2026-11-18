import { SplitTemplateReadModel } from '@Contexts/Ledger/Application/ReadModel/SplitTemplateReadModel';

export interface ISplitTemplateQueries {
  /** The templates of a group, the earliest saved first, each with its split as it was given. Empty for a group with none. */
  listByGroup(groupId: string): Promise<SplitTemplateReadModel[]>;
}
