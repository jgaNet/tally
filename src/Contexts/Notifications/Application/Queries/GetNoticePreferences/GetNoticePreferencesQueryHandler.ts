import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { INoticePreferenceQueries } from '@Contexts/Notifications/Application/Ports/INoticePreferenceQueries';
import { NoticePreferenceReadModel } from '@Contexts/Notifications/Application/ReadModel/NoticePreferenceReadModel';

/** A signed-in person reads their own preferences, each kind in order, on or off; nobody else's, and there is no id to ask for. */
export class GetNoticePreferencesQueryHandler extends QueryHandler<
  INoticePreferenceQueries,
  void,
  IResult<NoticePreferenceReadModel[]>
> {
  async execute(_: void, context: ExecutionContext): Promise<IResult<NoticePreferenceReadModel[]>> {
    const caller = requireSignedIn(context, 'Notifications');
    if (caller.isFailure()) return caller;

    return Result.ok(await this.queries.ofOwner(caller.data.value));
  }
}
