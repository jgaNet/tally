import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { NoticeIssuedEvent } from '@Contexts/Notifications/Domain/Notice/Events/NoticeEvents';
import { InvalidNoticeAmount } from '@Contexts/Notifications/Domain/Notice/NoticeExceptions';

/**
 * One message owed to one member about one fact, made once from it: that an expense concerns them, and their share of it; or, for a
 * debt that lasted (ADR 10), a reminder of what they still owe, which names no expense. It is the member's own: it names no group they
 * are still in, so it stays theirs after they leave. It is never changed once made.
 */
export class Notice extends AggregateRoot {
  private constructor(
    id: Id,
    readonly recipient: Id,
    readonly groupId: Id,
    readonly kind: 'expense' | 'reminder',
    readonly expenseId: Id | null,
    readonly amount: number,
    readonly at: Date,
  ) {
    super(id, 0);
  }

  /** A notice made now, under an id the notice generates, about an expense; it records that it was issued. */
  static create({
    recipient,
    groupId,
    expenseId,
    amount,
    now,
  }: {
    recipient: Id;
    groupId: Id;
    expenseId: Id;
    amount: number;
    now: Date;
  }): IResult<Notice> {
    if (!Number.isInteger(amount) || amount < 0) return Result.fail(new InvalidNoticeAmount());

    const notice = new Notice(Id.generate(), recipient, groupId, 'expense', expenseId, amount, now);
    notice.record(
      NoticeIssuedEvent.set({
        noticeId: notice._id.value,
        recipientId: recipient.value,
        kind: 'expense',
        expenseId: expenseId.value,
      }),
    );
    return Result.ok(notice);
  }

  /** A reminder made now: what the member still owes in the group, a whole amount above 0; it names no expense. */
  static remind({
    recipient,
    groupId,
    amount,
    now,
  }: {
    recipient: Id;
    groupId: Id;
    amount: number;
    now: Date;
  }): IResult<Notice> {
    if (!Number.isInteger(amount) || amount <= 0) return Result.fail(new InvalidNoticeAmount());

    const notice = new Notice(Id.generate(), recipient, groupId, 'reminder', null, amount, now);
    notice.record(
      NoticeIssuedEvent.set({
        noticeId: notice._id.value,
        recipientId: recipient.value,
        kind: 'reminder',
        expenseId: null,
      }),
    );
    return Result.ok(notice);
  }
}
