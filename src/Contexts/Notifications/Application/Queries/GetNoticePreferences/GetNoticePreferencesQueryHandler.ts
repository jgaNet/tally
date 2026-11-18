import { IResult, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import {
  INoticePreferenceQueries,
  NoticePreferenceView,
} from '@Contexts/Notifications/Domain/NoticePreference/Ports/INoticePreferenceQueries';

/** A signed-in person reads their own notice preferences, each kind on or off, in the order the kinds are declared (request 36). Nobody else reads them. */
export class GetNoticePreferencesQueryHandler extends QueryHandler<
  INoticePreferenceQueries,
  void,
  IResult<NoticePreferenceView[]>
> {
  async execute(_payload: void, context: ExecutionContext): Promise<IResult<NoticePreferenceView[]>> {
    const caller = requireSignedIn(context, 'Notifications');
    if (caller.isFailure()) return Result.fail(caller.error);

    return Result.ok(await this.queries.ofPerson(caller.data.value));
  }
}
