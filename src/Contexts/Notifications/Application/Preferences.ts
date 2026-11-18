import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';

import { INoticePreferenceStore } from '@Contexts/Notifications/Application/INoticePreferenceStore';
import { NOTICE_KINDS } from '@Contexts/Notifications/Domain/NoticePreference/NoticePreferences';
import { NoticeKind } from '@Contexts/Notifications/Domain/Notice/Notice';

/** What a person asks of one kind of notice: on or off for them (request 36). */
export interface SetNoticePreferenceInput {
  readonly kind: string;
  readonly enabled: boolean;
}

/** One kind of notice as a person reads it: whether it is made for them (request 36). */
export interface NoticePreferenceView {
  readonly kind: NoticeKind;
  readonly enabled: boolean;
}

/**
 * Turns a kind of notice on or off for the caller (request 36, the storm's SetNoticePreference). From then on a notice of a kind turned
 * off is not made for them, and one turned on again is made; nothing made earlier changes. Answers nothing (`204`); a kind that is not
 * one of the three is refused (`422`) and nothing changes.
 */
export const setNoticePreference = command(
  'SetNoticePreference',
  (preferences: INoticePreferenceStore, clock: Clock) =>
    async ({ kind, enabled }: SetNoticePreferenceInput, context): Promise<IResult<void>> => {
      const current = await preferences.preferencesOf(callerOf(context));
      const set = current.set(kind, enabled, clock());
      if (set.isFailure()) return Result.fail(set.error);
      if (current.changed) {
        await preferences.save(current);
        await publishDomainEvents(current, context);
      }
      return Result.ok(undefined);
    },
);

/**
 * The caller's own preferences, each kind in the order the API lists them, on or off (request 36, the storm's GetNoticePreferences).
 * Nobody else's is read.
 */
export const getNoticePreferences = query(
  'GetNoticePreferences',
  (preferences: INoticePreferenceStore) =>
    async (_: void, context): Promise<IResult<NoticePreferenceView[]>> => {
      const current = await preferences.preferencesOf(callerOf(context));
      return Result.ok(NOTICE_KINDS.map(kind => ({ kind, enabled: current.isOn(kind) })));
    },
);
