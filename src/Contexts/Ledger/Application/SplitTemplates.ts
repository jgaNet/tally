import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { publishDomainEvents } from '@Architecture/Application';
import { NotFoundException, Result, IResult } from '@Architecture/Domain';

import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { SplitTemplateView, TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/DTOs';
import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { ISplitTemplates } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplates';
import { ISplitTemplateQueries } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateQueries';

/** What a member asks to save: a name, and the split it is saved with (request 25). */
export interface SaveTemplateInput {
  groupId: string;
  name: string;
  split: TemplateSplit;
}

/**
 * Saves a split under a name, for a member of the group (request 25, docs/adr/0024). For anyone else the group does not exist. The name is
 * refused when another template of the group has it, whatever its case. Its id is the answer.
 */
export const saveTemplate = command(
  'SaveTemplate',
  (templates: ISplitTemplates, groupMembers: IGroupMembers) =>
    async ({ groupId, name, split }: SaveTemplateInput, context) => {
      const by = callerOf(context);
      const members = await groupMembers.membersOf(by, groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such group'));
      const archived = await groupMembers.isArchived(groupId);

      const sameName = await templates.findByName(groupId, name);
      const template = SplitTemplate.create({
        groupId,
        name,
        split,
        by,
        members,
        nameIsFree: sameName === undefined,
        archived,
      });
      if (template.isFailure()) return template;

      const saved = await templates.save(template.data);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(template.data, context);
      return Result.ok(template.data.id);
    },
);

/** What a member asks to replace: the template, and its name and split as they are to be. */
export interface ReplaceTemplateInput {
  id: string;
  name: string;
  split: TemplateSplit;
}

/**
 * Replaces a template's name and split, for the member who saved it or the group's owner (request 25). For anyone outside its group the
 * template does not exist; any other member is refused. A name another template of the group has is refused.
 */
export const replaceTemplate = command(
  'ReplaceTemplate',
  (templates: ISplitTemplates, groupMembers: IGroupMembers) =>
    async ({ id, name, split }: ReplaceTemplateInput, context) => {
      const by = callerOf(context);
      const stored = await templates.get(id);
      if (!stored) return Result.fail(new NotFoundException('Ledger', 'There is no such template'));
      const members = await groupMembers.membersOf(by, stored.groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such template'));
      const archived = await groupMembers.isArchived(stored.groupId);

      const sameName = await templates.findByName(stored.groupId, name);
      const replaced = stored.replace({
        by,
        members,
        name,
        split,
        nameIsFree: sameName === undefined || sameName.id === stored.id,
        archived,
      });
      if (replaced.isFailure()) return replaced;

      const saved = await templates.save(replaced.data);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(replaced.data, context);
      return Result.ok(undefined);
    },
);

/**
 * Removes a template, for the member who saved it or the group's owner (request 25). For anyone outside its group the template does not
 * exist; any other member is refused. The expenses split by it keep their shares.
 */
export const removeTemplate = command(
  'RemoveTemplate',
  (templates: ISplitTemplates, groupMembers: IGroupMembers) =>
    async ({ id }: { id: string }, context) => {
      const by = callerOf(context);
      const stored = await templates.get(id);
      if (!stored) return Result.fail(new NotFoundException('Ledger', 'There is no such template'));
      const members = await groupMembers.membersOf(by, stored.groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such template'));
      const archived = await groupMembers.isArchived(stored.groupId);

      const removed = stored.delete({ by, members, archived });
      if (removed.isFailure()) return removed;
      const saved = await templates.delete(removed.data);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(removed.data, context);
      return Result.ok(undefined);
    },
);

/**
 * The group's templates, for its members only (request 25): each with its split as it was given, the earliest saved first. For anyone
 * else the group does not exist.
 */
export const getGroupTemplates = query(
  'GetGroupTemplates',
  (queries: ISplitTemplateQueries, groupMembers: IGroupMembers) =>
    async ({ groupId }: { groupId: string }, context) => {
      const members = await groupMembers.membersOf(callerOf(context), groupId);
      if (!members) return Result.fail(new NotFoundException('Ledger', 'There is no such group'));
      const views: SplitTemplateView[] = await queries.listOf(groupId);
      return Result.ok(views);
    },
);

/**
 * The split an expense takes (request 25): the split it gives, or, when it names a template, the split of that template as if it had been
 * given. The template must be one of the group's: any other is `404`, as if it did not exist. The transport gives exactly one of the two.
 * Whether the members of the split are the group's, the payer among them, is the Expense's to decide, with the members it is given.
 */
export async function splitGiven(
  templates: ISplitTemplates,
  groupId: string,
  given: { split?: SplitInput; template?: string },
): Promise<IResult<SplitInput>> {
  if (given.template === undefined) return Result.ok(given.split as SplitInput);
  const template = await templates.get(given.template);
  if (!template || template.groupId !== groupId) {
    return Result.fail(new NotFoundException('Ledger', 'There is no such template'));
  }
  return Result.ok(template.asSplitInput());
}
