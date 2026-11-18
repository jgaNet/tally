import { Id, IResult } from '@Architecture/Domain';
import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { TemplateName } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateName';

/**
 * The split templates, stored by id and by group. `findById` answers the template, or null when there is none (a removed
 * one is gone); `findByName` answers the template of a group that has the name, whatever its case, or null when none has.
 */
export interface ISplitTemplateRepository {
  findById(id: Id): Promise<SplitTemplate | null>;
  findByName(groupId: Id, name: TemplateName): Promise<SplitTemplate | null>;
  save(template: SplitTemplate): Promise<IResult>;
}
