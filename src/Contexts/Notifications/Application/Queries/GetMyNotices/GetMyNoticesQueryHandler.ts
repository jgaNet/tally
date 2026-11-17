import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { INoticeQueries } from '@Contexts/Notifications/Application/Ports/INoticeQueries';
import { NoticeReadModel } from '@Contexts/Notifications/Application/ReadModel/NoticeReadModel';

/** A signed-in person lists their own notices, the most recent first, and nobody else's: there is no id to ask for. */
export class GetMyNoticesQueryHandler extends QueryHandler<INoticeQueries, void, IResult<NoticeReadModel[]>> {
  async execute(_: void, context: ExecutionContext): Promise<IResult<NoticeReadModel[]>> {
    const caller = requireSignedIn(context, 'Notifications');
    if (caller.isFailure()) return caller;

    return Result.ok(await this.queries.ofRecipient(caller.data.value));
  }
}
