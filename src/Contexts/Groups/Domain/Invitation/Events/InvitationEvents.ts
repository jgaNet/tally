import { DomainEvent } from '@Architecture/Domain';

/** An invitation was created: its id is the link, born with it, and the member who created it is who invited. */
export class InvitationCreatedEvent extends DomainEvent<{ invitationId: string; groupId: string; invitedBy: string }> {}
