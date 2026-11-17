import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { NoticeSnapshot } from '@Contexts/Notifications/Domain/Notice/DTOs';
import { NoticeIssuedEvent } from '@Contexts/Notifications/Domain/Notice/Events/NoticeEvents';

/**
 * What a person was told: that an expense of a group concerns them, and their share of it (request 17, docs/adr/0017). A notice is
 * the person's, not the group's: it carries the account it is for and nothing of membership, so it stays after they leave. It is
 * never changed once issued.
 *
 * `issue()` generates the id and records NoticeIssued; `fromSnapshot()` reads what the store kept, records nothing, and throws on
 * corrupted data.
 */
export class Notice extends AggregateRoot {
  private constructor(
    id: Id,
    readonly accountId: string,
    readonly groupId: string,
    readonly expenseId: string,
    readonly amount: number,
    readonly at: string,
  ) {
    super(id, 0);
  }

  static issue({
    accountId,
    groupId,
    expenseId,
    amount,
    at,
  }: {
    accountId: string;
    groupId: string;
    expenseId: string;
    amount: number;
    at: Date;
  }): IResult<Notice> {
    const id = Id.generate();
    const notice = new Notice(id, accountId, groupId, expenseId, amount, at.toISOString());
    notice.record(NoticeIssuedEvent.set({ noticeId: id.value, accountId, groupId, expenseId, amount }));
    return Result.ok(notice);
  }

  static fromSnapshot(snapshot: NoticeSnapshot): Notice {
    if (!snapshot.id || !snapshot.accountId || snapshot.kind !== 'expense' || !Number.isInteger(snapshot.amount)) {
      throw new Error(`The notice ${snapshot.id} is corrupted in the store`);
    }
    return new Notice(
      new Id(snapshot.id),
      snapshot.accountId,
      snapshot.groupId,
      snapshot.expenseId,
      snapshot.amount,
      snapshot.at,
    );
  }

  toSnapshot(): NoticeSnapshot {
    return {
      id: this._id.value,
      accountId: this.accountId,
      kind: 'expense',
      groupId: this.groupId,
      expenseId: this.expenseId,
      amount: this.amount,
      at: this.at,
    };
  }
}
