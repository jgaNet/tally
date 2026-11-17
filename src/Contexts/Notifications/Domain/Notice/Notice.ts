import { AggregateRoot, DomainEvent, Id } from '@Architecture/Domain';

/** The kinds of notice there are: one about an expense. */
export type NoticeKind = 'expense';

/** What a notice is made from: the member it is for, the group and expense it is about, and the member's share of the expense. */
export interface NoticeDraft {
  readonly recipientId: string;
  readonly groupId: string;
  readonly expenseId: string;
  readonly amount: number;
}

/** A notice as the store keeps it: its id, its recipient, what it is about, and when it was made (an ISO instant). */
export interface NoticeSnapshot {
  readonly id: string;
  readonly recipientId: string;
  readonly kind: NoticeKind;
  readonly groupId: string;
  readonly expenseId: string;
  readonly amount: number;
  readonly at: string;
}

/**
 * One message owed to one member about one fact, made once from the fact (the storm's Notice, conventions/domain.yaml). It is an
 * aggregate root because it records NoticeIssued, the fact that it was made (ADR 13). It is written once, by the reaction that makes
 * it, so nothing races it; it is the person's, and it stays theirs when they leave the group.
 */
export class Notice extends AggregateRoot {
  readonly #recipientId: string;
  readonly #groupId: string;
  readonly #expenseId: string;
  readonly #amount: number;
  readonly #at: string;

  private constructor(id: Id, draft: NoticeDraft, at: string) {
    super(id, 0);
    this.#recipientId = draft.recipientId;
    this.#groupId = draft.groupId;
    this.#expenseId = draft.expenseId;
    this.#amount = draft.amount;
    this.#at = at;
  }

  /** A notice made now: its identity is generated here (DOMAIN-IDENTITY), and its making records NoticeIssued. Pure: the time is given. */
  static create(draft: NoticeDraft, now: Date): Notice {
    const notice = new Notice(Id.generate(), draft, now.toISOString());
    notice.record(
      NoticeIssuedEvent.set({
        noticeId: notice._id.value,
        recipientId: draft.recipientId,
        groupId: draft.groupId,
        expenseId: draft.expenseId,
        amount: draft.amount,
        at: now.toISOString(),
      }),
    );
    return notice;
  }

  toSnapshot(): NoticeSnapshot {
    return {
      id: this._id.value,
      recipientId: this.#recipientId,
      kind: 'expense',
      groupId: this.#groupId,
      expenseId: this.#expenseId,
      amount: this.#amount,
      at: this.#at,
    };
  }
}

export type NoticeIssuedPayload = {
  noticeId: string;
  recipientId: string;
  groupId: string;
  expenseId: string;
  amount: number;
  at: string;
};

/** The fact that a notice was made for a member, about an expense. Made durable with the notice, in the reaction's transaction. */
export class NoticeIssuedEvent extends DomainEvent<NoticeIssuedPayload> {}
