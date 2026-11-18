import { DomainEvent } from '@Architecture/Domain';

/** A person turned a kind of notice on or off, from `at` (request 36): what is made from then on follows `enabled`. */
export class NoticePreferenceChangedEvent extends DomainEvent<{
  preferenceId: string;
  ownerId: string;
  kind: string;
  enabled: boolean;
  at: string;
}> {}
