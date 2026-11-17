import { AggregateRoot, DomainEvent, Id } from '@Architecture/Domain';

/** The kinds of notice there are: one about an expense (request 17), and a reminder of a lasting debt (request 18). */
export type NoticeKind = 'expense' | 'reminder';

/** What an expense's notice is made from: the member it is for, the group and expense it is about, and the member's share. */
export interface ExpenseNoticeDraft {
  readonly recipientId: string;
  readonly groupId: string;
  readonly expenseId: string;
  readonly amount: number;
}

/** What a reminder is made from: the member it is for, the group, and what the member still owes (positive, hundredths). */
export interface ReminderDraft {
  readonly recipientId: string;
  readonly groupId: string;
  readonly amount: number;
}

/** A notice as the store keeps it: its id, its recipient, its kind, what it is about, and when it was made (an ISO instant). */
export interface NoticeSnapshot {
  readonly id: string;
  readonly recipientId: string;
  readonly kind: NoticeKind;
  readonly groupId: string;
  /** The expense a notice of kind `expense` is about; a reminder has none. */
  readonly expenseId?: string;
  readonly amount: number;
  readonly at: string;
}

/**
 * One message owed to one member about one fact, made once from the fact (the storm's Notice, conventions/domain.yaml). It is an
 * aggregate root because it records NoticeIssued, the fact that it was made (ADR 13). It is written once, by the reaction or the sweep
 * that makes it, so nothing races it; it is the person's, and it stays theirs when they leave the group.
 */
export class Notice extends AggregateRoot {
  readonly #kind: NoticeKind;
  readonly #recipientId: string;
  readonly #groupId: string;
  readonly #expenseId: string | undefined;
  readonly #amount: number;
  readonly #at: string;

  private constructor(
    id: Id,
    kind: NoticeKind,
    recipientId: string,
    groupId: string,
    expenseId: string | undefined,
    amount: number,
    at: string,
  ) {
    super(id, 0);
    this.#kind = kind;
    this.#recipientId = recipientId;
    this.#groupId = groupId;
    this.#expenseId = expenseId;
    this.#amount = amount;
    this.#at = at;
  }

  /** An expense's notice made now: its identity is generated here (DOMAIN-IDENTITY), and its making records NoticeIssued. Pure: the time is given. */
  static create({ recipientId, groupId, expenseId, amount }: ExpenseNoticeDraft, now: Date): Notice {
    const notice = new Notice(Id.generate(), 'expense', recipientId, groupId, expenseId, amount, now.toISOString());
    notice.record(
      NoticeIssuedEvent.set({
        noticeId: notice._id.value,
        kind: 'expense',
        recipientId,
        groupId,
        expenseId,
        amount,
        at: now.toISOString(),
      }),
    );
    return notice;
  }

  /** A reminder made now, for a debt that lasted (request 18): it names no expense, and records NoticeIssued as any notice does. */
  static reminder({ recipientId, groupId, amount }: ReminderDraft, now: Date): Notice {
    const notice = new Notice(Id.generate(), 'reminder', recipientId, groupId, undefined, amount, now.toISOString());
    notice.record(
      NoticeIssuedEvent.set({
        noticeId: notice._id.value,
        kind: 'reminder',
        recipientId,
        groupId,
        amount,
        at: now.toISOString(),
      }),
    );
    return notice;
  }

  toSnapshot(): NoticeSnapshot {
    return {
      id: this._id.value,
      recipientId: this.#recipientId,
      kind: this.#kind,
      groupId: this.#groupId,
      ...(this.#expenseId !== undefined && { expenseId: this.#expenseId }),
      amount: this.#amount,
      at: this.#at,
    };
  }
}

export type NoticeIssuedPayload = {
  noticeId: string;
  kind: NoticeKind;
  recipientId: string;
  groupId: string;
  expenseId?: string;
  amount: number;
  at: string;
};

/** The fact that a notice was made for a member: about an expense, or a reminder. Made durable with the notice, in the same transaction. */
export class NoticeIssuedEvent extends DomainEvent<NoticeIssuedPayload> {}
