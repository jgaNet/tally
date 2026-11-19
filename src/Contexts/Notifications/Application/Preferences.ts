import { publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Result } from '@Architecture/Domain';

import { isNoticeKind } from '@Contexts/Notifications/Domain/Preference/DTOs';
import { InvalidNoticeKindException } from '@Contexts/Notifications/Domain/Preference/NoticePreferenceExceptions';
import {
  INoticePreferenceQueries,
  INoticePreferences,
} from '@Contexts/Notifications/Domain/Preference/Ports/INoticePreferences';

/** What the caller sets: a kind of notice, on or off (request 36). */
export interface SetNoticePreferenceInput {
  kind: string;
  enabled: boolean;
}

/**
 * Turns a kind of notice on or off for the caller, and for nobody else (request 36, docs/adr/0036). A kind named that is not one of the three
 * is refused; setting a kind to the state it has is a success that changes nothing. Answered at once.
 */
export const setNoticePreference = command(
  'SetNoticePreference',
  (preferences: INoticePreferences) =>
    async ({ kind, enabled }: SetNoticePreferenceInput, context) => {
      if (!isNoticeKind(kind)) return Result.fail(new InvalidNoticeKindException());
      const current = await preferences.get(callerOf(context));
      if (!current.set(kind, enabled)) return Result.ok(undefined);
      const saved = await preferences.save(current);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(current, context);
      return Result.ok(undefined);
    },
);

/** The caller's own preferences, each kind in the order the API lists them: nobody else's are asked for, so nobody else reads them. */
export const getNoticePreferences = query(
  'GetNoticePreferences',
  (preferences: INoticePreferenceQueries) => async (_input: void, context) =>
    Result.ok(await preferences.preferencesOf(callerOf(context))),
);
