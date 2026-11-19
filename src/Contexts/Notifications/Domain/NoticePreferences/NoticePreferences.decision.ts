import { Result } from '@Architecture/Domain';
import { Decision, decided } from '@Architecture/Domain/Lite/Decision';

import { NOTICE_KINDS, NoticeKind } from '@Contexts/Notifications/Domain/Notice/Notice';
import { InvalidNoticeKindException } from './NoticePreferencesExceptions';

/** What a setting says: the kind as typed, and whether it is on. */
export interface SetNoticePreferenceCommand {
  kind: string;
  enabled: boolean;
}

/** The kind and the value a preference is set to, once they are allowed. */
export interface NoticeChoice {
  kind: NoticeKind;
  enabled: boolean;
}

/**
 * Turning a kind of notice on or off (request 36): the kind is one of the three, and anyone may set their own, so the only refusal is
 * a kind that is none of them. Setting a kind to the value it has is allowed and changes nothing (the aggregate says so).
 */
export const decideSetNoticePreference: Decision<NoticeChoice, SetNoticePreferenceCommand, never, undefined> = (
  _given,
  { kind, enabled },
) => {
  if (!(NOTICE_KINDS as readonly string[]).includes(kind)) return Result.fail(new InvalidNoticeKindException());
  return decided({ kind: kind as NoticeKind, enabled });
};
