import { DomainEvent } from '@Architecture/Domain';

/**
 * An invitation to a group was made by one of its members. Recorded by `Invitation.issue()`, once the invitation is
 * stored (docs/adr/0001). No integration event carries it: the invitation's id is the link, and it is read here.
 */
export class InvitationCreatedEvent extends DomainEvent<{ invitationId: string; groupId: string; invitedBy: string }> {}
