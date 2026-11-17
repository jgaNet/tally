import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { NotFoundException, Result } from '@Architecture/Domain';

import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IInvitationRepository } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationRepository';
import { IInvitationQueries } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationQueries';
import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';

/** Makes an invitation to a group, by a link: a member of the group, and only one, may make it. Its id is the answer. */
export const createInvitation = command(
  'CreateInvitation',
  (invitations: IInvitationRepository, groups: IGroupRepository, clock: Clock) =>
    async ({ groupId }: { groupId: string }, context) => {
      const group = await groups.findById(groupId);
      if (!group) return Result.fail(new NotFoundException('Groups', 'There is no such group'));

      const invitation = Invitation.issue({ group, invitedBy: callerOf(context), at: clock() });
      if (invitation.isFailure()) return invitation;

      const saved = await invitations.save(invitation.data);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(invitation.data, context);
      return Result.ok(invitation.data.id);
    },
);

/**
 * Joins the caller to the group of an invitation, as a member with the same rights as the others. Anyone signed in who
 * has the link may join, once: an account that is a member already is refused.
 */
export const acceptInvitation = command(
  'AcceptInvitation',
  (invitations: IInvitationRepository, groups: IGroupRepository, clock: Clock) =>
    async ({ id }: { id: string }, context) => {
      const invitation = await invitations.findById(id);
      if (!invitation) return Result.fail(new NotFoundException('Groups', 'There is no such invitation'));

      const group = await groups.findById(invitation.groupId);
      if (!group) return Result.fail(new NotFoundException('Groups', 'There is no such group'));

      const joined = group.join({ accountId: callerOf(context), at: clock() });
      if (joined.isFailure()) return joined;

      const saved = await groups.save(group);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(group, context);
      return Result.ok(undefined);
    },
);

/** Reads an invitation, for anyone signed in who has its link: the group's id and name, and who invited. */
export const getInvitation = query(
  'GetInvitation',
  (invitations: IInvitationQueries) =>
    async ({ id }: { id: string }) => {
      const invitation = await invitations.findInvitation(id);
      if (!invitation) return Result.fail(new NotFoundException('Groups', 'There is no such invitation'));
      return Result.ok(invitation);
    },
);
