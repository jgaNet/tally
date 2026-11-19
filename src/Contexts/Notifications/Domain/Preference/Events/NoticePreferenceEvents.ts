import { DomainEvent } from '@Architecture/Domain';

/** A person turned a kind of notice on or off: the preferences, the person, the kind, the new choice and when it was made. */
export class NoticePreferenceChangedEvent extends DomainEvent<{
  preferencesId: string;
  memberId: string;
  kind: 'expense' | 'reminder' | 'budget';
  enabled: boolean;
  changedAt: string;
}> {}
