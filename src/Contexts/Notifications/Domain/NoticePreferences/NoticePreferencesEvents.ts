import { DomainEvent } from '@Architecture/Domain';

import { NoticeKind } from '@Contexts/Notifications/Domain/Notice/Notice';

/**
 * A person turned a kind of notice on or off (request 36, ADR 34): recorded by the change of the preference, and published with it.
 * Nothing reacts to it: the notices are made from the preferences as they are when a notice would be made.
 */
export class NoticePreferenceChangedEvent extends DomainEvent<{
  memberId: string;
  kind: NoticeKind;
  enabled: boolean;
  at: string;
}> {}
