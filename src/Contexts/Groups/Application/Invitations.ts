import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';

import { IGroupStore } from '@Contexts/Groups/Application/IGroupStore';
import { IInvitationStore, InvitationView } from '@Contexts/Groups/Application/IInvitationStore';
import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';
import { InvitationNotFoundException } from '@Contexts/Groups/Domain/Invitation/InvitationExceptions';
import { GroupNotFoundException } from '@Contexts/Groups/Domain/Group/GroupExceptions';

/**
 * Creates an invitation to a group, for a member of it: anyone else gets the group's `404`, since the group is not there
 * for them. The invitation is saved, and what it recorded (InvitationCreated) goes out with the commit, through the
 * outbox. Answers the invitation's id, which is the link (feature 3).
 */
export const createInvitation = command(
  'CreateInvitation',
  (groups: IGroupStore, invitations: IInvitationStore, clock: Clock) =>
    async (groupId: string, context): Promise<IResult<string>> => {
      const caller = callerOf(context);
      const group = await groups.findById(groupId);
      if (!group || !group.hasMember(caller)) return Result.fail(new GroupNotFoundException());
      const open = group.openForChanges();
      if (open.isFailure()) return Result.fail(open.error);

      const invitation = Invitation.issue({ groupId, invitedBy: caller }, clock());
      await invitations.add(invitation);
      await publishDomainEvents(invitation, context);
      return Result.ok(invitation.toSnapshot().id);
    },
);

/**
 * Reads an invitation by its id, before joining: the group's id and name, and who invited. Any signed-in person who holds
 * the link may read it, whether or not they are a member: that is what the link is for.
 */
export const getInvitation = query(
  'GetInvitation',
  (invitations: IInvitationStore) =>
    async (invitationId: string): Promise<IResult<InvitationView>> => {
      const view = await invitations.viewOf(invitationId);
      return view ? Result.ok(view) : Result.fail(new InvitationNotFoundException());
    },
);

/**
 * The signed-in person joins the group the invitation is to: they become its last member, once. The group is saved at the
 * version it was read at, and what it recorded (MemberJoined) goes out with the commit. Refused with `409` when the caller
 * is already a member. The invitation is not changed, so anyone may use it again.
 */
export const acceptInvitation = command(
  'AcceptInvitation',
  (groups: IGroupStore, invitations: IInvitationStore, clock: Clock) =>
    async (invitationId: string, context): Promise<IResult<void>> => {
      const invitation = await invitations.findById(invitationId);
      if (!invitation) return Result.fail(new InvitationNotFoundException());

      const group = await groups.findById(invitation.groupId);
      if (!group) return Result.fail(new GroupNotFoundException());

      const joined = group.join(callerOf(context), clock());
      if (joined.isFailure()) return joined;

      await groups.save(group);
      await publishDomainEvents(group, context);
      return Result.ok(undefined);
    },
);
