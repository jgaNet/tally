import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { SetNoticePreferenceCommandEvent } from '@Contexts/Notifications/Application/Commands/SetNoticePreference/SetNoticePreferenceCommandEvent';
import { INoticePreferencesRepository } from '@Contexts/Notifications/Domain/NoticePreferences/Ports/INoticePreferencesRepository';
import { NoticePreferences } from '@Contexts/Notifications/Domain/NoticePreferences/NoticePreferences';

/**
 * The signed-in person turns a kind of notice on or off for themselves. Only their own preferences are read and changed: the caller is
 * the one whose preferences they are, and no one else's is reachable from here. The first change makes their row; a change to what a
 * kind already is changes nothing and records nothing.
 */
export class SetNoticePreferenceCommandHandler extends CommandHandler<SetNoticePreferenceCommandEvent> {
  constructor(
    private preferences: INoticePreferencesRepository,
    private clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: SetNoticePreferenceCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Notifications');
    if (caller.isFailure()) return caller;

    const ownerId = new Id(caller.data.value);
    const preferences = (await this.preferences.findByOwner(ownerId.value)) ?? NoticePreferences.open({ ownerId });
    const set = preferences.set({ kind: payload.kind, enabled: payload.enabled, now: this.clock() });
    if (set.isFailure()) return set;

    const saved = await this.preferences.save(preferences);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(preferences, context);
    return Result.ok();
  }
}
