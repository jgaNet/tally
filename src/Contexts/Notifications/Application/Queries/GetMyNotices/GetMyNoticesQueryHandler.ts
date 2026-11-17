import { IResult, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { INoticeQueries, NoticeView } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeQueries';

/**
 * A signed-in person lists their own notices, the most recent first (request 17). Nobody else reads them, and reading them
 * asks no other context: a notice stays its recipient's after they leave the group.
 */
export class GetMyNoticesQueryHandler extends QueryHandler<INoticeQueries, void, IResult<NoticeView[]>> {
  async execute(_payload: void, context: ExecutionContext): Promise<IResult<NoticeView[]>> {
    const caller = requireSignedIn(context, 'Notifications');
    if (caller.isFailure()) return Result.fail(caller.error);

    return Result.ok(await this.queries.ofRecipient(caller.data.value));
  }
}
