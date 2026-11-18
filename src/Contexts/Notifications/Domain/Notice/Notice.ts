import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { NoticeKind, NoticeSnapshot } from '@Contexts/Notifications/Domain/Notice/DTOs';
import { NoticeIssuedEvent } from '@Contexts/Notifications/Domain/Notice/Events/NoticeEvents';

/** The budget a notice of a passed month names: the category, the month (`YYYY-MM`) and the budget it passed (request 24). */
export interface BudgetOfNotice {
  category: string;
  month: string;
  budget: number;
}

/**
 * What a person was told: that an expense of a group concerns them, and their share of it (request 17, docs/adr/0017); that a debt of
 * theirs in a group has lasted and what they still owe (a reminder, request 18, docs/adr/0018); or that a month passed a category's budget
 * in a group, and what the month spends (a budget, request 24, docs/adr/0023). A notice is the person's, not the group's: it carries the
 * account it is for and nothing of membership, so it stays after they leave. It is never changed once issued.
 *
 * `issue()`, `remind()` and `issueBudget()` generate the id and record NoticeIssued; `fromSnapshot()` reads what the store kept, records
 * nothing, and throws on corrupted data.
 */
export class Notice extends AggregateRoot {
  private constructor(
    id: Id,
    readonly accountId: string,
    readonly kind: NoticeKind,
    readonly groupId: string,
    readonly expenseId: string | undefined,
    readonly amount: number,
    readonly at: string,
    readonly budgetOf: BudgetOfNotice | undefined,
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
    const notice = new Notice(id, accountId, 'expense', groupId, expenseId, amount, at.toISOString(), undefined);
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
    const notice = new Notice(id, accountId, 'reminder', groupId, undefined, amount, at.toISOString(), undefined);
    notice.record(NoticeIssuedEvent.set({ noticeId: id.value, accountId, groupId, amount }));
    return notice;
  }

  /**
   * A month passed a budget (request 24): the person is told the category, the month, the budget and what the month spends (`amount`).
   * It names no expense. The store keeps one per person, group, category and month.
   */
  static issueBudget({
    accountId,
    groupId,
    category,
    month,
    budget,
    amount,
    at,
  }: {
    accountId: string;
    groupId: string;
    category: string;
    month: string;
    budget: number;
    amount: number;
    at: Date;
  }): Notice {
    if (!Number.isInteger(budget) || budget < 1 || !Number.isInteger(amount) || amount <= budget) {
      throw new Error(`A budget notice is for a month that spends more than its budget, not ${amount} of ${budget}`);
    }
    const id = Id.generate();
    const notice = new Notice(id, accountId, 'budget', groupId, undefined, amount, at.toISOString(), {
      category,
      month,
      budget,
    });
    notice.record(NoticeIssuedEvent.set({ noticeId: id.value, accountId, groupId, category, month, budget, amount }));
    return notice;
  }

  static fromSnapshot(snapshot: NoticeSnapshot): Notice {
    const expenseMatchesKind = snapshot.kind === 'expense' ? !!snapshot.expenseId : snapshot.expenseId === undefined;
    const budgetMatchesKind =
      snapshot.kind === 'budget'
        ? snapshot.category !== undefined && snapshot.month !== undefined && Number.isInteger(snapshot.budget)
        : snapshot.category === undefined && snapshot.month === undefined && snapshot.budget === undefined;
    if (
      !snapshot.id ||
      !snapshot.accountId ||
      !expenseMatchesKind ||
      !budgetMatchesKind ||
      !Number.isInteger(snapshot.amount)
    ) {
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
      snapshot.kind === 'budget' &&
        snapshot.category !== undefined &&
        snapshot.month !== undefined &&
        snapshot.budget !== undefined
        ? { category: snapshot.category, month: snapshot.month, budget: snapshot.budget }
        : undefined,
    );
  }

  toSnapshot(): NoticeSnapshot {
    return {
      id: this._id.value,
      accountId: this.accountId,
      kind: this.kind,
      groupId: this.groupId,
      ...(this.expenseId === undefined ? {} : { expenseId: this.expenseId }),
      ...(this.budgetOf === undefined
        ? {}
        : { category: this.budgetOf.category, month: this.budgetOf.month, budget: this.budgetOf.budget }),
      amount: this.amount,
      at: this.at,
    };
  }
}
