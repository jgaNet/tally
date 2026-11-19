import { Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { NOTICE_KINDS, NoticeKind } from '@Contexts/Notifications/Domain/Notice/Notice';
import { decideSetNoticePreference } from '@Contexts/Notifications/Domain/NoticePreferences/NoticePreferences.decision';

import { INoticePreferenceRepository } from './INoticePreferenceRepository';

/** A kind of notice as a person reads it: on or off (request 36). */
export interface NoticePreferenceView {
  kind: NoticeKind;
  enabled: boolean;
}

/**
 * A signed-in person turns a kind of notice on or off, for themselves (request 36). A notice of a kind turned off is not made for them
 * from then on, and one of a kind turned on again is made from then on; nothing made earlier changes. Nobody else's preference changes.
 * A kind that is none of the three is refused; the same value again changes nothing.
 */
export const setNoticePreference = command(
  'SetNoticePreference',
  (preferences: INoticePreferenceRepository, clock: Clock) =>
    async ({ kind, enabled }: { kind: string; enabled: boolean }, context) => {
      return preferences.inTransaction(async () => {
        const by = callerOf(context);
        const now = clock();
        const decision = decideSetNoticePreference(undefined, { kind, enabled }, now);
        if (decision.isFailure()) return decision;

        const prefs = await preferences.of(by);
        prefs.set(decision.data.state.kind, decision.data.state.enabled, now);
        await preferences.save(prefs);
        await publishDomainEvents(prefs, context);
        return Result.ok(undefined);
      });
    },
);

/**
 * A signed-in person reads their own preferences: each kind, in the order the kinds are given (`expense`, `reminder`, `budget`), on or off
 * (request 36). Nobody else reads them.
 */
export const getNoticePreferences = query(
  'GetNoticePreferences',
  (preferences: INoticePreferenceRepository) => async (_input: void, context) => {
    const prefs = await preferences.of(callerOf(context));
    return Result.ok<NoticePreferenceView[]>(NOTICE_KINDS.map(kind => ({ kind, enabled: prefs.isOn(kind) })));
  },
);
