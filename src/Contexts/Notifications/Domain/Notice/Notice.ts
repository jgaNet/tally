import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { NoticeSnapshot } from '@Contexts/Notifications/Domain/Notice/DTOs';
import { NoticeIssuedEvent } from '@Contexts/Notifications/Domain/Notice/Events/NoticeEvents';

/**
 * What a person was told: that an expense of a group concerns them, and their share of it (request 17, docs/adr/0017), or that a debt
 * of theirs in a group has lasted and what they still owe (a reminder, request 18, docs/adr/0018). A notice is the person's, not the
 * group's: it carries the account it is for and nothing of membership, so it stays after they leave. It is never changed once issued.
 *
 * `issue()` and `remind()` generate the id and record NoticeIssued; `fromSnapshot()` reads what the store kept, records nothing, and
 * throws on corrupted data.
 */
export class Notice extends AggregateRoot {
  private constructor(
    id: Id,
    readonly accountId: string,
    readonly kind: 'expense' | 'reminder',
    readonly groupId: string,
    readonly expenseId: string | undefined,
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
    const notice = new Notice(id, accountId, 'expense', groupId, expenseId, amount, at.toISOString());
    notice.record(NoticeIssuedEvent.set({ noticeId: id.value, accountId, groupId, expenseId, amount }));
    return Result.ok(notice);
  }

  /** A reminder: a debt of more than 2000 that has lasted, what is still owed in the group. It names no expense (docs/adr/0018). */
  static remind({
    accountId,
    groupId,
    amount,
    at,
  }: {
    accountId: string;
    groupId: string;
    amount: number;
    at: Date;
  }): Notice {
    // A reminder is made by the sweep for a debt it has checked to be more than 2000: an amount that is not owed is a programming error.
    if (!Number.isInteger(amount) || amount <= 0) throw new Error(`A reminder is for an amount owed, not ${amount}`);
    const id = Id.generate();
    const notice = new Notice(id, accountId, 'reminder', groupId, undefined, amount, at.toISOString());
    notice.record(NoticeIssuedEvent.set({ noticeId: id.value, accountId, groupId, amount }));
    return notice;
  }

  static fromSnapshot(snapshot: NoticeSnapshot): Notice {
    const expenseMatchesKind = snapshot.kind === 'reminder' ? snapshot.expenseId === undefined : !!snapshot.expenseId;
    if (!snapshot.id || !snapshot.accountId || !expenseMatchesKind || !Number.isInteger(snapshot.amount)) {
      throw new Error(`The notice ${snapshot.id} is corrupted in the store`);
    }
    return new Notice(
      new Id(snapshot.id),
      snapshot.accountId,
      snapshot.kind,
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
      kind: this.kind,
      groupId: this.groupId,
      ...(this.expenseId === undefined ? {} : { expenseId: this.expenseId }),
      amount: this.amount,
      at: this.at,
    };
  }
}
