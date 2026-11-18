import { DomainEvent } from '@Architecture/Domain';

/** A person turned a kind of notice on or off (request 36): who, which kind, and the value it now has. Recorded only when it changes. */
export class NoticePreferenceChangedEvent extends DomainEvent<{ person: string; kind: string; enabled: boolean }> {}
