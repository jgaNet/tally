import { Result } from '@Architecture/Domain';
import { callerOf, query } from '@Architecture/Application/Lite/UseCase';

import { INoticeStore, NoticeView } from './INoticeStore';

/**
 * A signed-in person reads their own notices, the most recent first (request 17). Nobody else reads them, and nothing about the
 * groups they are in is asked: a notice stays theirs after they leave a group.
 */
export const getMyNotices = query(
  'GetMyNotices',
  (notices: INoticeStore) => async (_input: void, context) =>
    Result.ok<NoticeView[]>(await notices.noticesOf(callerOf(context))),
);
