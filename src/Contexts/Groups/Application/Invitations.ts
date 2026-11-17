import { NotFoundException, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';

import { IGroupRepository } from './IGroupRepository';
import { IInvitationQueries, InvitationView } from './IInvitationQueries';
import { IInvitationRepository } from './IInvitationRepository';

/**
 * A member of a group issues an invitation to it: a link whose id is the only proof a joiner needs, usable by anyone who
 * holds it, any number of times (ADR 4). Answers the invitation's id. Anyone else gets the answer for a group that does
 * not exist.
 */
export const createInvitation = command(
  'CreateInvitation',
  (groups: IGroupRepository, invitations: IInvitationRepository, clock: Clock) =>
    async ({ id }: { id: string }, context) => {
      const caller = callerOf(context);
      const group = await groups.get(id);
      if (!group || !group.hasMember(caller)) return Result.fail(new NotFoundException('Groups', 'No group is found'));

      const invitation = Invitation.issue({ groupId: group._id.value, invitedBy: caller, at: clock() });
      await invitations.insert(invitation);
      await publishDomainEvents(invitation, context);
      return Result.ok(invitation._id.value);
    },
);

/**
 * A signed-in person accepts an invitation: they join the group it is to, as its last member, once. Answers nothing.
 * The group is saved at the version it was read at; a concurrent change is re-read and decided again (CONC-OPTIMISTIC).
 */
export const acceptInvitation = command(
  'AcceptInvitation',
  (invitations: IInvitationRepository, groups: IGroupRepository, clock: Clock) =>
    async ({ id }: { id: string }, context) => {
      const invitation = await invitations.get(id);
      if (!invitation) return Result.fail(new NotFoundException('Groups', 'No invitation is found'));

      const group = await groups.get(invitation.groupId);
      if (!group) return Result.fail(new NotFoundException('Groups', 'No group is found'));

      const joined = group.join(callerOf(context), clock());
      if (joined.isFailure()) return joined;
      await groups.save(group);
      await publishDomainEvents(group, context);
      return Result.ok(undefined);
    },
);

/** Anyone signed in who holds the link reads the invitation: the group's id and name, and who invited them. */
export const getInvitation = query(
  'GetInvitation',
  (invitations: IInvitationQueries) =>
    async ({ id }: { id: string }) => {
      const invitation: InvitationView | undefined = await invitations.invitationOf(id);
      if (!invitation) return Result.fail(new NotFoundException('Groups', 'No invitation is found'));
      return Result.ok(invitation);
    },
);
