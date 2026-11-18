import { NotFoundException, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { SplitTemplate, TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import {
  decideRemoveTemplate,
  decideReplaceTemplate,
  decideSaveTemplate,
} from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate.decision';

import { IGroupMembers, MemberOfGroup } from './IGroupMembers';
import { ISplitTemplateQueries, TemplateView } from './ISplitTemplateQueries';
import { ISplitTemplateRepository } from './ISplitTemplateRepository';

/**
 * A member of a group saves a split under a name (request 25): a name of 1 to 60 characters, not only spaces, unique in the group whatever
 * its case, and a split by members equally or by shares, the members of the group, each listed once, each with at least 1 share. Answers
 * the new template's id. Anyone who is not a member gets the answer for a group that does not exist.
 */
export const saveTemplate = command(
  'SaveTemplate',
  (templates: ISplitTemplateRepository, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ groupId, name, split }: { groupId: string; name: string; split: TemplateSplit }, context) => {
      return templates.inTransaction(async () => {
        const by = callerOf(context);
        const members = await groupMembers.membersOf(groupId, by);
        if (!members) return Result.fail(new NotFoundException('Ledger', 'No group is found'));
        const nameTaken = await templates.isNameTaken(groupId, name);

        const decision = decideSaveTemplate(
          { memberIds: memberIdsOf(members), nameTaken },
          { by, name, split },
          clock(),
        );
        if (decision.isFailure()) return decision;

        const template = SplitTemplate.create({ groupId, savedBy: by, ...decision.data.state });
        await templates.insert(template);
        await publishDomainEvents(template, context);
        return Result.ok(template._id.value);
      });
    },
);

/**
 * The member who saved a template, or the group's owner, replaces it, under the same rules as a saving (request 25). Any other member is
 * refused; anyone who is not a member gets the answer for a template that does not exist.
 */
export const replaceTemplate = command(
  'ReplaceTemplate',
  (templates: ISplitTemplateRepository, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ id, name, split }: { id: string; name: string; split: TemplateSplit }, context) => {
      return templates.inTransaction(async () => {
        const by = callerOf(context);
        const template = await templates.get(id);
        if (!template) return Result.fail(new NotFoundException('Ledger', 'No template is found'));
        const stored = template.toSnapshot();
        const members = await groupMembers.membersOf(stored.groupId, by);
        if (!members) return Result.fail(new NotFoundException('Ledger', 'No template is found'));
        const nameTaken = await templates.isNameTaken(stored.groupId, name, id);

        const decision = decideReplaceTemplate(
          { template: stored, memberIds: memberIdsOf(members), ownerId: ownerIdOf(members), nameTaken },
          { by, name, split },
          clock(),
        );
        if (decision.isFailure()) return decision;

        template.replace(decision.data.state);
        await templates.save(template);
        await publishDomainEvents(template, context);
        return Result.ok(undefined);
      });
    },
);

/**
 * The member who saved a template, or the group's owner, removes it (request 25). No expense is changed by it. Any other member is refused;
 * anyone who is not a member gets the answer for a template that does not exist.
 */
export const removeTemplate = command(
  'RemoveTemplate',
  (templates: ISplitTemplateRepository, groupMembers: IGroupMembers, clock: Clock) =>
    async ({ id }: { id: string }, context) => {
      return templates.inTransaction(async () => {
        const by = callerOf(context);
        const template = await templates.get(id);
        if (!template) return Result.fail(new NotFoundException('Ledger', 'No template is found'));
        const stored = template.toSnapshot();
        const members = await groupMembers.membersOf(stored.groupId, by);
        if (!members) return Result.fail(new NotFoundException('Ledger', 'No template is found'));

        const decision = decideRemoveTemplate({ template: stored, ownerId: ownerIdOf(members) }, { by }, clock());
        if (decision.isFailure()) return decision;

        template.remove();
        await templates.remove(template);
        await publishDomainEvents(template, context);
        return Result.ok(undefined);
      });
    },
);

/**
 * A member of a group reads its templates (request 25): each one with its id, group, name and split as it was given, the earliest saved
 * first. Anyone who is not a member gets the answer for a group that does not exist.
 */
export const getGroupTemplates = query(
  'GetGroupTemplates',
  (templates: ISplitTemplateQueries, groupMembers: IGroupMembers) =>
    async ({ id }: { id: string }, context) => {
      if (!(await groupMembers.membersOf(id, callerOf(context)))) {
        return Result.fail(new NotFoundException('Ledger', 'No group is found'));
      }
      const answer: TemplateView[] = await templates.templatesOf(id);
      return Result.ok(answer);
    },
);

const memberIdsOf = (members: MemberOfGroup[]): string[] => members.map(member => member.memberId);

/** The group's owner, the member whose role is owner; no one, if none is (a group always has one). */
const ownerIdOf = (members: MemberOfGroup[]): string => members.find(member => member.role === 'owner')?.memberId ?? '';
