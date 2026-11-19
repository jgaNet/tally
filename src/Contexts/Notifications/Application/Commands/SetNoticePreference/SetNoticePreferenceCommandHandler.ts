import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { INoticePreferenceRepository } from '@Contexts/Notifications/Domain/Preference/Ports/INoticePreferenceRepository';
import { NoticePreferences } from '@Contexts/Notifications/Domain/Preference/NoticePreferences';
import { SetNoticePreferenceCommandEvent } from '@Contexts/Notifications/Application/Commands/SetNoticePreference/SetNoticePreferenceCommandEvent';

/**
 * A signed-in person turns a kind of notice on or off for themselves (request 36, ADR 27). Only their own preferences are
 * changed: the caller's id is the person. The first change makes their preferences; later ones change them, in a
 * transaction of their own, and a conflict with another change of theirs is re-read and re-decided (CONFLICT_ATTEMPTS).
 * Nothing else is told: no other context hears of a preference.
 */
export class SetNoticePreferenceCommandHandler extends CommandHandler<SetNoticePreferenceCommandEvent> {
  constructor(
    private readonly preferences: INoticePreferenceRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: SetNoticePreferenceCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Notifications');
    if (caller.isFailure()) return caller;
    const memberId = caller.data;
    const at = this.clock();

    const current = await this.preferences.findByMember(memberId);
    let aggregate: NoticePreferences;
    if (current) {
      const changed = current.change({ kind: payload.kind, enabled: payload.enabled, at });
      if (changed.isFailure()) return changed;
      aggregate = current;
    } else {
      const created = NoticePreferences.register({ memberId, kind: payload.kind, enabled: payload.enabled, at });
      if (created.isFailure()) return created;
      aggregate = created.data;
    }

    const saved = await this.preferences.save(aggregate);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(aggregate, context);
    return Result.ok();
  }
}
