import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';

import { ISplitTemplateStore, TemplateView } from '@Contexts/Ledger/Application/ISplitTemplateStore';
import { GroupMemberRole, IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';
import { GroupNotFoundException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { SplitTemplate, TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import {
  NotTheSaverOrOwnerException,
  TemplateNotFoundException,
} from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateExceptions';

/** What a member asks to save: the group it is in, the name, and the split it is saved as. The saver is the caller. */
export interface SaveTemplateInput {
  readonly groupId: string;
  readonly name: string;
  readonly split: TemplateSplit;
}

/** What a member asks to put in a template's place: the whole of it, the name and the split, under the rules of a save. */
export interface ReplaceTemplateInput {
  readonly templateId: string;
  readonly name: string;
  readonly split: TemplateSplit;
}

/**
 * Saves a split under a name, in a group the caller is a member of (request 25). A caller who is not a member gets the group's `404`. The
 * name is free in the group whatever its case (`409`), and the split's members are members of the group, each once, with at least 1 share
 * (`422`). Answers the new template's id; what it recorded (TemplateSaved) goes out with the commit, through the outbox.
 */
export const saveTemplate = command(
  'SaveTemplate',
  (templates: ISplitTemplateStore, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ groupId, name, split }: SaveTemplateInput, context): Promise<IResult<string>> => {
      const savedBy = callerOf(context);
      const members = await groupMembers.membersOf(groupId);
      if (!members || !isMember(members, savedBy)) return Result.fail(new GroupNotFoundException());

      const holder = await templates.nameHeldBy(groupId, name);
      const saved = SplitTemplate.create({ groupId, savedBy, name, split }, idsOf(members), holder, clock());
      if (saved.isFailure()) return Result.fail(saved.error);

      await templates.add(saved.data);
      await publishDomainEvents(saved.data, context);
      return Result.ok(saved.data.toSnapshot().id);
    },
);

/**
 * Replaces a template under the rules of a save (request 25). Only the member who saved it, or the group's owner, may (`403` to any other
 * member); to someone outside the group, or for a template that is not there, it is `404`. What it recorded (TemplateReplaced) goes out with
 * the commit.
 */
export const replaceTemplate = command(
  'ReplaceTemplate',
  (templates: ISplitTemplateStore, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ templateId, name, split }: ReplaceTemplateInput, context): Promise<IResult<void>> => {
      const found = await changeable(templates, groupMembers, templateId, context);
      if (found.isFailure()) return Result.fail(found.error);
      const { template, members } = found.data;

      const holder = await templates.nameHeldBy(template.groupId, name);
      const replaced = template.replace({ name, split }, idsOf(members), holder, clock());
      if (replaced.isFailure()) return replaced;

      await templates.save(template);
      await publishDomainEvents(template, context);
      return Result.ok(undefined);
    },
);

/**
 * Removes a template (request 25): no expense changes, and no one can split by it any more. Only the member who saved it, or the group's
 * owner, may (`403`); a template that is not there, or of a group the caller is not in, is `404`. What it recorded (TemplateRemoved) goes out
 * with the commit.
 */
export const removeTemplate = command(
  'RemoveTemplate',
  (templates: ISplitTemplateStore, groupMembers: IGroupMembers, clock: Clock) =>
    async (templateId: string, context): Promise<IResult<void>> => {
      const found = await changeable(templates, groupMembers, templateId, context);
      if (found.isFailure()) return Result.fail(found.error);
      const { template } = found.data;

      template.remove(clock());
      await templates.remove(template);
      await publishDomainEvents(template, context);
      return Result.ok(undefined);
    },
);

/**
 * A group's templates, as a member of the group reads them (request 25): each with its id, group, name and split as it was given, the earliest
 * saved first. A caller who is not a member gets the group's `404`.
 */
export const getGroupTemplates = query(
  'GetGroupTemplates',
  (templates: ISplitTemplateStore, groupMembers: IGroupMembers) =>
    async (groupId: string, context): Promise<IResult<TemplateView[]>> => {
      const members = await groupMembers.membersOf(groupId);
      if (!members || !isMember(members, callerOf(context))) return Result.fail(new GroupNotFoundException());
      return Result.ok(await templates.listOf(groupId));
    },
);

/**
 * The template a caller may change, as the caller may see it: it is there for them (a template of a group they are a member of, else the same
 * `404` as one that does not exist), and they saved it or are the group's owner (else `403`). Answers the template and the group's members, the
 * ones its split may be in.
 */
async function changeable(
  templates: ISplitTemplateStore,
  groupMembers: IGroupMembers,
  templateId: string,
  context: ExecutionContext,
): Promise<IResult<{ template: SplitTemplate; members: GroupMemberRole[] }>> {
  const template = await templates.findById(templateId);
  if (!template) return Result.fail(new TemplateNotFoundException());

  const members = await groupMembers.membersOf(template.groupId);
  const caller = callerOf(context);
  const me = members?.find(member => member.memberId === caller);
  if (!members || !me) return Result.fail(new TemplateNotFoundException());
  if (template.savedBy !== caller && me.role !== 'owner') return Result.fail(new NotTheSaverOrOwnerException());
  return Result.ok({ template, members });
}

const isMember = (members: readonly GroupMemberRole[], memberId: string): boolean =>
  members.some(member => member.memberId === memberId);

const idsOf = (members: readonly GroupMemberRole[]): string[] => members.map(member => member.memberId);
