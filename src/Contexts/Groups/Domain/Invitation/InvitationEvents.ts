import { DomainEvent } from '@Architecture/Domain';

/**
 * An invitation to a group was issued, by a member of it. Recorded by the invitation's creation and published after its
 * save; nothing reacts to it yet, so it is not an integration event (ADR 4).
 */
export class InvitationCreatedEvent extends DomainEvent<{
  invitationId: string;
  groupId: string;
  invitedBy: string;
  createdAt: Date;
}> {}
