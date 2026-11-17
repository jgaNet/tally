import { DomainEvent } from '@Architecture/Domain';

/** The sweep saw a member owe more than 2000 in a group, and had not seen so: the debt is noted from that run (request 18). */
export class DebtNotedEvent extends DomainEvent<{ accountId: string; groupId: string; amount: number }> {}

/** The sweep saw a member owe 2000 or less in a group after noting it: the debt is no longer noted (request 18). */
export class DebtClearedEvent extends DomainEvent<{ accountId: string; groupId: string }> {}

/** The sweep reminded a member of a debt that lasted, and so it is not reminded again until a period has passed (request 18). */
export class ReminderIssuedEvent extends DomainEvent<{ accountId: string; groupId: string; amount: number }> {}
