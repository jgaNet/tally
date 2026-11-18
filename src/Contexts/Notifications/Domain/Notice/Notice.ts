import { AggregateRoot, Id } from '@Architecture/Domain';

import { NoticeIssuedEvent } from './NoticeEvents';

/** A notice as it is stored: the member it is for, the group and the expense it is about, the member's share and when it was made. */
export interface NoticeSnapshot {
  id: string;
  memberId: string;
  kind: NoticeKind;
  groupId: string;
  /** The expense an `expense` notice is about; a reminder has none. */
  expenseId?: string;
  /** What a `budget` notice (request 24) is about: the category and the month it passed its budget, and the budget. */
  category?: string;
  month?: string;
  budget?: number;
  amount: number;
  at: string;
}

export type NoticeKind = 'expense' | 'reminder' | 'budget';

/**
 * One message owed to one member about one fact, made once from the fact (conventions/domain.yaml): that a member's share of an
 * expense was recorded, with the share's amount. A notice is the member's: it stays theirs after they leave the group, so nothing
 * about the group's membership is kept with it. Its id is born here (DOMAIN-IDENTITY).
 */
export class Notice extends AggregateRoot {
  readonly #memberId: string;
  readonly #groupId: string;
  readonly #kind: NoticeKind;
  readonly #expenseId: string | undefined;
  readonly #amount: number;
  readonly #at: string;
  readonly #passed: { category: string; month: string; budget: number } | undefined;

  private constructor(
    id: Id,
    memberId: string,
    groupId: string,
    kind: NoticeKind,
    expenseId: string | undefined,
    amount: number,
    at: string,
    passed?: { category: string; month: string; budget: number },
  ) {
    super(id, 0);
    this.#kind = kind;
    this.#memberId = memberId;
    this.#groupId = groupId;
    this.#expenseId = expenseId;
    this.#amount = amount;
    this.#at = at;
    this.#passed = passed;
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
        const notice = new Notice(Id.generate(), share.memberId, groupId, 'expense', expenseId, share.amount, when);
        notice.record(
          NoticeIssuedEvent.set({
            noticeId: notice._id.value,
            memberId: share.memberId,
            kind: 'expense',
            groupId,
            expenseId,
            amount: share.amount,
            at: when,
          }),
        );
        return notice;
      });
  }

  /**
   * A reminder (request 18): a notice for a member who has owed `owed` in a group for a period, made at `at` (the application's
   * clock, handed in by the sweep). It has no expense. Records `NoticeIssued`.
   */
  static remind({
    memberId,
    groupId,
    owed,
    at,
  }: {
    memberId: string;
    groupId: string;
    owed: number;
    at: Date;
  }): Notice {
    const when = at.toISOString();
    const notice = new Notice(Id.generate(), memberId, groupId, 'reminder', undefined, owed, when);
    notice.record(
      NoticeIssuedEvent.set({
        noticeId: notice._id.value,
        memberId,
        kind: 'reminder',
        groupId,
        amount: owed,
        at: when,
      }),
    );
    return notice;
  }

  /**
   * One notice for each member of the group when a month's spending in a category passed its budget (request 24): `spent` is what the month
   * spends, `budget` what it passed, `month` is `YYYY-MM`. The payer receives one too: every member is told. Made at `at` (the application's
   * clock, handed in by the reaction). Each notice records `NoticeIssued`.
   */
  static budgetPassed({
    groupId,
    category,
    month,
    budget,
    spent,
    memberIds,
    at,
  }: {
    groupId: string;
    category: string;
    month: string;
    budget: number;
    spent: number;
    memberIds: readonly string[];
    at: Date;
  }): Notice[] {
    const when = at.toISOString();
    return memberIds.map(memberId => {
      const notice = new Notice(Id.generate(), memberId, groupId, 'budget', undefined, spent, when, {
        category,
        month,
        budget,
      });
      notice.record(
        NoticeIssuedEvent.set({
          noticeId: notice._id.value,
          memberId,
          kind: 'budget',
          groupId,
          category,
          month,
          budget,
          amount: spent,
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
      kind: this.#kind,
      groupId: this.#groupId,
      ...(this.#expenseId === undefined ? {} : { expenseId: this.#expenseId }),
      ...(this.#passed === undefined ? {} : this.#passed),
      amount: this.#amount,
      at: this.#at,
    };
  }
}
