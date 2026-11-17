import { DomainEvent } from '@Architecture/Domain';

/** An invitation was created: its id (the link), the group it leads to, who created it, and when. */
export class InvitationCreatedEvent extends DomainEvent<{
  invitationId: string;
  groupId: string;
  invitedBy: string;
  createdAt: string;
}> {}
