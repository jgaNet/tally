import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { ExpenseSharePart, INoticeSnapshot, NoticeKind } from '@Contexts/Notifications/Domain/Notice/DTOs';
import { NoticeIssuedEvent } from '@Contexts/Notifications/Domain/Notice/Events/NoticeEvents';
import { InvalidNoticeException } from '@Contexts/Notifications/Domain/Notice/NoticeExceptions';
import { LINGERING_DEBT_OVER } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';

/**
 * Notice is the aggregate root of one message owed to one person about one fact, made once from the fact (request 17, the
 * storm `notices`; request 18, the storm `reminders`). Two kinds: an expense recorded with its recipient in the split (the
 * group, the expense, and the recipient's share), and a reminder that a debt lasted (the group and what is still owed, more
 * than 2000, with no expense). A notice is its recipient's: it is not tied to their membership, and stays theirs after they
 * leave the group. Once issued it does not change.
 */
export class Notice extends AggregateRoot {
  readonly #recipient: string;
  readonly #kind: NoticeKind;
  readonly #groupId: string;
  readonly #expenseId: string | null;
  readonly #amount: number;
  readonly #at: Date;

  private constructor(
    id: Id,
    recipient: string,
    kind: NoticeKind,
    groupId: string,
    expenseId: string | null,
    amount: number,
    at: Date,
    version: number,
  ) {
    super(id, version);
    this.#recipient = recipient;
    this.#kind = kind;
    this.#groupId = groupId;
    this.#expenseId = expenseId;
    this.#amount = amount;
    this.#at = at;
  }

  /**
   * Who an expense recorded tells, and of what share: each member of its split other than its payer, who recorded it, in
   * the order of the split. A member listed twice is told once. `alreadyTold` are the members who already hold a notice of
   * this expense: a notice is made once from the fact, so they are not told again.
   */
  static toTellOfExpense({
    paidBy,
    shares,
    alreadyTold,
  }: {
    paidBy: string;
    shares: ExpenseSharePart[];
    alreadyTold: string[];
  }): ExpenseSharePart[] {
    const told = new Set([paidBy, ...alreadyTold]);
    const toTell: ExpenseSharePart[] = [];
    for (const share of shares) {
      if (told.has(share.memberId)) continue;
      told.add(share.memberId);
      toTell.push({ memberId: share.memberId, amount: share.amount });
    }
    return toTell;
  }

  /** A notice to `recipient` of their share of an expense: its id is generated here, and NoticeIssued is recorded. */
  static issue({
    recipient,
    groupId,
    expenseId,
    amount,
    at,
  }: {
    recipient: string;
    groupId: string;
    expenseId: string;
    amount: number;
    at: Date;
  }): IResult<Notice> {
    if (!recipient) return Result.fail(new InvalidNoticeException('A notice is for someone'));
    if (!groupId || !expenseId)
      return Result.fail(new InvalidNoticeException('A notice is about an expense of a group'));
    if (!Number.isInteger(amount)) return Result.fail(new InvalidNoticeException('A share is a whole number of cents'));

    const notice = new Notice(Id.generate(), recipient, 'expense', groupId, expenseId, amount, at, 0);
    notice.record(
      NoticeIssuedEvent.set({
        noticeId: notice._id.value,
        recipient,
        kind: 'expense',
        groupId,
        expenseId,
        amount,
        at: at.toISOString(),
      }),
    );
    return Result.ok(notice);
  }

  /**
   * A reminder to `recipient` that they still owe `amount` in the group, more than 2000 (request 18): its id is generated here,
   * and NoticeIssued is recorded. The decision that a debt lasted is the DebtWatch's; this only makes the notice it asks for.
   */
  static remind({
    recipient,
    groupId,
    amount,
    at,
  }: {
    recipient: string;
    groupId: string;
    amount: number;
    at: Date;
  }): IResult<Notice> {
    if (!recipient) return Result.fail(new InvalidNoticeException('A notice is for someone'));
    if (!groupId) return Result.fail(new InvalidNoticeException('A reminder is about a group'));
    if (!Number.isInteger(amount) || amount <= LINGERING_DEBT_OVER)
      return Result.fail(new InvalidNoticeException('A reminder is for more than 2000 still owed'));

    const notice = new Notice(Id.generate(), recipient, 'reminder', groupId, null, amount, at, 0);
    notice.record(
      NoticeIssuedEvent.set({
        noticeId: notice._id.value,
        recipient,
        kind: 'reminder',
        groupId,
        amount,
        at: at.toISOString(),
      }),
    );
    return Result.ok(notice);
  }

  /** The notice as the store holds it. Records nothing; throws on a notice no rule could have made. */
  static fromSnapshot({ _id, recipient, kind, groupId, expenseId, amount, at, version }: INoticeSnapshot): Notice {
    const aboutAnExpense = kind === 'expense' && !!expenseId;
    const aboutADebt =
      kind === 'reminder' && expenseId === null && Number.isInteger(amount) && amount > LINGERING_DEBT_OVER;
    if (
      !recipient ||
      !groupId ||
      (!aboutAnExpense && !aboutADebt) ||
      (kind === 'expense' && !Number.isInteger(amount)) ||
      isNaN(at.getTime())
    ) {
      throw new Error(`Corrupted notice ${_id}`);
    }
    return new Notice(new Id(_id), recipient, kind, groupId, expenseId, amount, at, version);
  }

  get recipient(): string {
    return this.#recipient;
  }

  toSnapshot(): INoticeSnapshot {
    return {
      _id: this._id.value,
      recipient: this.#recipient,
      kind: this.#kind,
      groupId: this.#groupId,
      expenseId: this.#expenseId,
      amount: this.#amount,
      at: new Date(this.#at),
      version: this.version,
    };
  }
}
