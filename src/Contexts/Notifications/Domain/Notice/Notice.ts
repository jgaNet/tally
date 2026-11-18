import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { DEBT_THRESHOLD } from '@Contexts/Notifications/Domain/Debt/Threshold';
import { InvalidNoticeAmount, InvalidReminderAmount } from '@Contexts/Notifications/Domain/Notice/NoticeExceptions';
import { NoticeIssuedEvent } from '@Contexts/Notifications/Domain/Notice/Events/NoticeEvents';

/** The kinds of fact a notice is about: an expense of the group (request 17), a debt that lasted (request 18), or a month that passed a budget (request 24). */
export type NoticeKind = 'expense' | 'reminder' | 'budget';

/** What a budget's notice is about: the category, the month (`YYYY-MM`), and the budget the month passed (request 24). */
export interface BudgetFact {
  category: string;
  month: string;
  budget: number;
}

/**
 * One message owed to one member about one fact: that an expense of their group concerns them, with their share of it, that
 * a debt of theirs has lasted, with what they still owe, or that a month's spending in a category passed its budget, with
 * what it spends. It is made once, by `create()`, `createReminder()` or `createBudget()`, which validate the amount and
 * record NoticeIssued. A notice is the member's own: it names no group membership, so it stays theirs after they leave the
 * group (ADR 11). A reminder names no expense (ADR 12); a budget's notice names its category, month and budget (ADR 17).
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
    readonly budgetFact: BudgetFact | null = null,
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
        category: null,
        month: null,
        budget: null,
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
        category: null,
        month: null,
        budget: null,
      }),
    );
    return Result.ok(notice);
  }

  /** A budget's notice: what a month spends in a category of the group, the month's budget, to one member (request 24). */
  static createBudget({
    memberId,
    groupId,
    category,
    month,
    budget,
    amount,
    at,
  }: {
    memberId: Id;
    groupId: Id;
    category: string;
    month: string;
    budget: number;
    amount: number;
    at: Date;
  }): IResult<Notice> {
    if (!Number.isSafeInteger(amount) || amount < 0) return Result.fail(new InvalidNoticeAmount());

    const notice = new Notice(Id.generate(), 0, 'budget', memberId, groupId, null, amount, at, {
      category,
      month,
      budget,
    });
    notice.record(
      NoticeIssuedEvent.set({
        noticeId: notice._id.value,
        kind: notice.kind,
        memberId: notice.memberId.value,
        groupId: notice.groupId.value,
        expenseId: notice.expenseId?.value ?? null,
        amount: notice.amount,
        issuedAt: notice.at.toISOString(),
        category: category,
        month: month,
        budget: budget,
      }),
    );
    return Result.ok(notice);
  }

  /** The notice as it is stored: `expenseId` only for a notice of an expense, the budget's facts only for a budget's notice. */
  toSnapshot() {
    return {
      id: this._id.value,
      memberId: this.memberId.value,
      groupId: this.groupId.value,
      ...(this.expenseId && { expenseId: this.expenseId.value }),
      kind: this.kind,
      amount: this.amount,
      at: this.at.toISOString(),
      ...(this.budgetFact && { ...this.budgetFact }),
    };
  }
}
