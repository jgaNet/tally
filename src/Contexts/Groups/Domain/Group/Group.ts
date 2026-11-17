import { AggregateRoot, Id } from '@Architecture/Domain';

import { GroupCreatedEvent } from './GroupEvents';
import { Currency, CurrencyCode } from './Currency';
import { GroupName } from './GroupName';

/** A group as it is stored: its name, its currency, its owner, and when it was created. */
export interface GroupSnapshot {
  id: string;
  name: string;
  currency: CurrencyCode;
  ownerId: string;
  createdAt: string;
}

/**
 * People who share expenses in one currency, fixed when it is created, owned by the account that created it (ADR 3).
 * Its id is born here, once; its rules are the decision's (`Group.decision.ts`), which checks what it is given before
 * it is made. The owner is its first member: the membership is written with the group, by the store.
 */
export class Group extends AggregateRoot {
  readonly #name: GroupName;
  readonly #currency: Currency;
  readonly #ownerId: string;
  readonly #createdAt: Date;

  private constructor(id: Id, name: GroupName, currency: Currency, ownerId: string, createdAt: Date) {
    super(id);
    this.#name = name;
    this.#currency = currency;
    this.#ownerId = ownerId;
    this.#createdAt = createdAt;
  }

  /** A new group, with its id generated here, recording that its owner registered it at `at`. */
  static register({
    name,
    currency,
    ownerId,
    at,
  }: {
    name: GroupName;
    currency: Currency;
    ownerId: string;
    at: Date;
  }): Group {
    const group = new Group(Id.generate(), name, currency, ownerId, at);
    group.record(GroupCreatedEvent.set({ groupId: group._id.value, ownerId, createdAt: at }));
    return group;
  }

  get name(): GroupName {
    return this.#name;
  }

  get currency(): Currency {
    return this.#currency;
  }

  get ownerId(): string {
    return this.#ownerId;
  }

  get createdAt(): Date {
    return this.#createdAt;
  }

  toSnapshot(): GroupSnapshot {
    return {
      id: this._id.value,
      name: this.#name.value,
      currency: this.#currency.value,
      ownerId: this.#ownerId,
      createdAt: this.#createdAt.toISOString(),
    };
  }
}
