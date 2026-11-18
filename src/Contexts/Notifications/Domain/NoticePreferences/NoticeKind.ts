import { IResult, Result } from '@Architecture/Domain';

import { InvalidNoticeKind } from '@Contexts/Notifications/Domain/Notice/NoticeExceptions';

/** The kinds of notice a person may turn on or off (request 36), in the order they are read. */
export const NOTICE_KINDS = ['expense', 'reminder', 'budget'] as const;

export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** A kind as a request names it: one of the three kinds, or a refusal behind the 202. */
export function noticeKindOf(value: string): IResult<NoticeKind> {
  return (NOTICE_KINDS as readonly string[]).includes(value)
    ? Result.ok(value as NoticeKind)
    : Result.fail(new InvalidNoticeKind());
}
