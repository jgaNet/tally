import { TemplateReadModel } from '@Contexts/Ledger/Application/ReadModel/TemplateReadModel';

/** The templates of a group, read for its members: the earliest saved first. */
export interface ITemplateQueries {
  ofGroup(groupId: string): Promise<TemplateReadModel[]>;
}
