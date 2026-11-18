import { IResult, Result } from '@Architecture/Domain';
import { CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { NoticePreferences } from '@Contexts/Notifications/Domain/NoticePreference/NoticePreferences';
import { INoticePreferenceRepository } from '@Contexts/Notifications/Domain/NoticePreference/Ports/INoticePreferenceRepository';
import { SetNoticePreferenceCommandEvent } from '@Contexts/Notifications/Application/Commands/SetNoticePreference/SetNoticePreferenceCommandEvent';

/**
 * The signed-in person turns a kind of notice on or off (request 36). Their preferences are read, the kind set, and saved with what
 * they recorded, published after the commit, in one transaction. A refused kind or value changes nothing. Its answer is the
 * preferences' id.
 */
export class SetNoticePreferenceCommandHandler extends CommandHandler<SetNoticePreferenceCommandEvent> {
  constructor(private preferences: INoticePreferenceRepository) {
    super();
  }

  async execute(event: SetNoticePreferenceCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Notifications');
    if (caller.isFailure()) return Result.fail(caller.error);
    const person = caller.data.value;

    const preferences = (await this.preferences.findByPerson(person)) ?? NoticePreferences.open(person);
    const set = preferences.set({ kind: event.payload.kind, enabled: event.payload.enabled });
    if (set.isFailure()) return Result.fail(set.error);

    const saved = await this.preferences.save(preferences);
    if (saved.isFailure()) return Result.fail(saved.error);

    await publishDomainEvents(preferences, context);
    return Result.ok(preferences._id.value);
  }
}
