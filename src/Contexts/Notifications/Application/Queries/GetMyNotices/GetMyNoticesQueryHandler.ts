import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { INoticeQueries } from '@Contexts/Notifications/Application/Ports/INoticeQueries';
import { NoticeReadModel } from '@Contexts/Notifications/Application/ReadModel/NoticeReadModel';

/** A signed-in person lists their own notices, the most recent first. Nobody else's are read, and a notice of a group left stays theirs. */
export class GetMyNoticesQueryHandler extends QueryHandler<INoticeQueries, undefined, IResult<NoticeReadModel[]>> {
  async execute(_: undefined, context: ExecutionContext): Promise<IResult<NoticeReadModel[]>> {
    const caller = requireSignedIn(context, 'Notifications');
    if (caller.isFailure()) return caller;
    return Result.ok(await this.queries.listFor(caller.data.value));
  }
}
