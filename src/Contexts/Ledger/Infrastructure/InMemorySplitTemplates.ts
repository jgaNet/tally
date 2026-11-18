import { Id, IResult, Result } from '@Architecture/Domain';

import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';
import { TemplateName } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateName';

/** The split templates kept in memory, for the unit tests of the commands that read them: a template is kept as it was saved. */
export class InMemorySplitTemplates implements ISplitTemplateRepository {
  private templates = new Map<string, SplitTemplate>();

  async findById(id: Id): Promise<SplitTemplate | null> {
    return this.templates.get(id.value) ?? null;
  }

  async nameTaken(groupId: Id, name: string, except: Id | null): Promise<boolean> {
    const key = TemplateName.keyOf(name);
    return [...this.templates.values()].some(
      template =>
        template.groupId.value === groupId.value &&
        template._id.value !== except?.value &&
        TemplateName.keyOf(template.name.value) === key,
    );
  }

  async save(template: SplitTemplate): Promise<IResult> {
    this.templates.set(template._id.value, template);
    return Result.ok();
  }

  async dropGroup(groupId: Id): Promise<void> {
    for (const [key, template] of this.templates) {
      if (template.groupId.value === groupId.value) this.templates.delete(key);
    }
  }

  async remove(template: SplitTemplate): Promise<IResult> {
    this.templates.delete(template._id.value);
    return Result.ok();
  }
}
