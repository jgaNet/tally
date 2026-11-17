import { callerOf, query } from '@Architecture/Application/Lite/UseCase';
import { Result } from '@Architecture/Domain';

import { INoticeQueries } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeQueries';

/** The caller's own notices, the most recent first: nobody else's are asked for, so nobody else reads them (request 17). */
export const getMyNotices = query(
  'GetMyNotices',
  (notices: INoticeQueries) => async (_input: void, context) => Result.ok(await notices.noticesOf(callerOf(context))),
);
