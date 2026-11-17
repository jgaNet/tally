import { DomainEvent } from '@Architecture/Domain';

/**
 * An invitation to a group was created: its id (the link's proof), the group it invites to, and the member who
 * created it.
 */
export class InvitationCreatedEvent extends DomainEvent<{ invitationId: string; groupId: string; invitedBy: string }> {}
