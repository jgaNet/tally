import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { DEBT_THRESHOLD } from '@Contexts/Notifications/Domain/Debt/Threshold';
import { InvalidNoticeAmount, InvalidReminderAmount } from '@Contexts/Notifications/Domain/Notice/NoticeExceptions';
import { NoticeIssuedEvent } from '@Contexts/Notifications/Domain/Notice/Events/NoticeEvents';

/** The kinds of fact a notice is about: an expense of the group (request 17), or a debt that lasted (request 18). */
export type NoticeKind = 'expense' | 'reminder';

/**
 * One message owed to one member about one fact: that an expense of their group concerns them, with their share of it, or
 * that a debt of theirs has lasted, with what they still owe. It is made once, by `create()` or `createReminder()`, which
 * validate the amount and record NoticeIssued. A notice is the member's own: it names no group membership, so it stays
 * theirs after they leave the group (ADR 11). A reminder names no expense (ADR 12).
 */
export class Notice extends AggregateRoot {
  private constructor(
    id: Id,
    version: number,
    readonly kind: NoticeKind,
    readonly memberId: Id,
    readonly groupId: Id,
    readonly expenseId: Id | null,
    readonly amount: number,
    readonly at: Date,
  ) {
    super(id, version);
  }

  static create({
    memberId,
    groupId,
    expenseId,
    amount,
    at,
  }: {
    memberId: Id;
    groupId: Id;
    expenseId: Id;
    amount: number;
    at: Date;
  }): IResult<Notice> {
    if (!Number.isSafeInteger(amount) || amount < 0) return Result.fail(new InvalidNoticeAmount());

    const notice = new Notice(Id.generate(), 0, 'expense', memberId, groupId, expenseId, amount, at);
    notice.record(
      NoticeIssuedEvent.set({
        noticeId: notice._id.value,
        kind: notice.kind,
        memberId: notice.memberId.value,
        groupId: notice.groupId.value,
        expenseId: notice.expenseId?.value ?? null,
        amount: notice.amount,
        issuedAt: notice.at.toISOString(),
      }),
    );
    return Result.ok(notice);
  }

  /** A reminder: what the member still owes, more than the threshold (request 18). */
  static createReminder({
    memberId,
    groupId,
    amount,
    at,
  }: {
    memberId: Id;
    groupId: Id;
    amount: number;
    at: Date;
  }): IResult<Notice> {
    if (!Number.isSafeInteger(amount) || amount <= DEBT_THRESHOLD) return Result.fail(new InvalidReminderAmount());

    const notice = new Notice(Id.generate(), 0, 'reminder', memberId, groupId, null, amount, at);
    notice.record(
      NoticeIssuedEvent.set({
        noticeId: notice._id.value,
        kind: notice.kind,
        memberId: notice.memberId.value,
        groupId: notice.groupId.value,
        expenseId: notice.expenseId?.value ?? null,
        amount: notice.amount,
        issuedAt: notice.at.toISOString(),
      }),
    );
    return Result.ok(notice);
  }

  /** The notice as it is stored: `expenseId` only for a notice of an expense. */
  toSnapshot() {
    return {
      id: this._id.value,
      memberId: this.memberId.value,
      groupId: this.groupId.value,
      ...(this.expenseId && { expenseId: this.expenseId.value }),
      kind: this.kind,
      amount: this.amount,
      at: this.at.toISOString(),
    };
  }
}
