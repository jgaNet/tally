import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { InvalidNoticeAmount } from '@Contexts/Notifications/Domain/Notice/NoticeExceptions';
import { NoticeIssuedEvent } from '@Contexts/Notifications/Domain/Notice/Events/NoticeEvents';

/**
 * One message owed to one member about one fact: that an expense of their group concerns them, with their share of it.
 * It is made once, by `create()`, which validates the amount and records NoticeIssued. A notice is the member's own: it
 * names no group membership, so it stays theirs after they leave the group (ADR 11).
 */
export class Notice extends AggregateRoot {
  private constructor(
    id: Id,
    version: number,
    readonly memberId: Id,
    readonly groupId: Id,
    readonly expenseId: Id,
    readonly amount: number,
    readonly at: Date,
  ) {
    super(id, version);
  }

  /** The kind of fact the notice is about: an expense. */
  get kind(): 'expense' {
    return 'expense';
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

    const notice = new Notice(Id.generate(), 0, memberId, groupId, expenseId, amount, at);
    notice.record(
      NoticeIssuedEvent.set({
        noticeId: notice._id.value,
        memberId: memberId.value,
        groupId: groupId.value,
        expenseId: expenseId.value,
        amount,
        issuedAt: at.toISOString(),
      }),
    );
    return Result.ok(notice);
  }

  /** The notice as it is stored. */
  toSnapshot() {
    return {
      id: this._id.value,
      memberId: this.memberId.value,
      groupId: this.groupId.value,
      expenseId: this.expenseId.value,
      kind: this.kind,
      amount: this.amount,
      at: this.at.toISOString(),
    };
  }
}
