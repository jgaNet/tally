import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { INoticePreferenceQueries } from '@Contexts/Notifications/Application/Ports/INoticePreferenceQueries';
import { NoticePreferenceReadModel } from '@Contexts/Notifications/Application/ReadModel/NoticePreferenceReadModel';

/** A signed-in person reads their own notice preferences, each kind on or off (request 36). Nobody else's are read. */
export class GetNoticePreferencesQueryHandler extends QueryHandler<
  INoticePreferenceQueries,
  undefined,
  IResult<NoticePreferenceReadModel[]>
> {
  async execute(_: undefined, context: ExecutionContext): Promise<IResult<NoticePreferenceReadModel[]>> {
    const caller = requireSignedIn(context, 'Notifications');
    if (caller.isFailure()) return caller;
    return Result.ok(await this.queries.preferencesOf(caller.data.value));
  }
}
