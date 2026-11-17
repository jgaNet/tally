import { IResult, Result } from '@Architecture/Domain';
import { callerOf, query } from '@Architecture/Application/Lite/UseCase';

import { INoticeReads, NoticeView } from '@Contexts/Notifications/Application/INoticeReads';

/**
 * A signed-in person's notices, the most recent first (request 17): only their own, whatever groups they are in or have left. Nobody
 * else's is read, and reading them asks no other context.
 */
export const getMyNotices = query(
  'GetMyNotices',
  (notices: INoticeReads) =>
    async (_: void, context): Promise<IResult<NoticeView[]>> =>
      Result.ok(await notices.listFor(callerOf(context))),
);
