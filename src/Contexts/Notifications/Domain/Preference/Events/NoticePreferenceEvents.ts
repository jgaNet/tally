import { DomainEvent } from '@Architecture/Domain';

import { NoticeKind } from '@Contexts/Notifications/Domain/Notice/DTOs';

/**
 * A person turned a kind of notice on or off (request 36, docs/adr/0036). Recorded by `NoticePreferences.set()`, and only when the kind
 * changes: turning on a kind that is on records nothing.
 */
export class NoticePreferenceChangedEvent extends DomainEvent<{
  accountId: string;
  kind: NoticeKind;
  enabled: boolean;
}> {}
