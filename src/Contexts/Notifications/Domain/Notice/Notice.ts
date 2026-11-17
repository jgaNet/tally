import { AggregateRoot, Id } from '@Architecture/Domain';

import { NoticeIssuedEvent } from './NoticeEvents';

/** A notice as it is stored: the member it is for, the group and the expense it is about, the member's share and when it was made. */
export interface NoticeSnapshot {
  id: string;
  memberId: string;
  groupId: string;
  expenseId: string;
  amount: number;
  at: string;
}

/**
 * One message owed to one member about one fact, made once from the fact (conventions/domain.yaml): that a member's share of an
 * expense was recorded, with the share's amount. A notice is the member's: it stays theirs after they leave the group, so nothing
 * about the group's membership is kept with it. Its id is born here (DOMAIN-IDENTITY).
 */
export class Notice extends AggregateRoot {
  readonly #memberId: string;
  readonly #groupId: string;
  readonly #expenseId: string;
  readonly #amount: number;
  readonly #at: string;

  private constructor(id: Id, memberId: string, groupId: string, expenseId: string, amount: number, at: string) {
    super(id, 0);
    this.#memberId = memberId;
    this.#groupId = groupId;
    this.#expenseId = expenseId;
    this.#amount = amount;
    this.#at = at;
  }

  /**
   * One notice for each member of an expense's split but its payer, with that member's share, made at `at` (the application's
   * clock, handed in by the reaction). The payer receives none: they recorded the expense. Each notice records `NoticeIssued`.
   */
  static issueFor({
    groupId,
    expenseId,
    payer,
    shares,
    at,
  }: {
    groupId: string;
    expenseId: string;
    payer: string;
    shares: readonly { memberId: string; amount: number }[];
    at: Date;
  }): Notice[] {
    const when = at.toISOString();
    return shares
      .filter(share => share.memberId !== payer)
      .map(share => {
        const notice = new Notice(Id.generate(), share.memberId, groupId, expenseId, share.amount, when);
        notice.record(
          NoticeIssuedEvent.set({
            noticeId: notice._id.value,
            memberId: share.memberId,
            groupId,
            expenseId,
            amount: share.amount,
            at: when,
          }),
        );
        return notice;
      });
  }

  /** The notice as it is stored. */
  toSnapshot(): NoticeSnapshot {
    return {
      id: this._id.value,
      memberId: this.#memberId,
      groupId: this.#groupId,
      expenseId: this.#expenseId,
      amount: this.#amount,
      at: this.#at,
    };
  }
}
