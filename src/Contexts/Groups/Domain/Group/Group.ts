import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { GroupCreatedEvent, MemberJoinedEvent } from './GroupEvents';
import { Currency, CurrencyCode } from './Currency';
import { AlreadyMemberException } from './GroupExceptions';
import { GroupName } from './GroupName';

/** A member as it is stored: the account, and when it joined. */
export interface GroupMemberSnapshot {
  accountId: string;
  joinedAt: string;
}

/** A group as it is stored: its name, its currency, its owner, when it was created, and its members in the order they joined. */
export interface GroupSnapshot {
  id: string;
  name: string;
  currency: CurrencyCode;
  ownerId: string;
  createdAt: string;
  members: GroupMemberSnapshot[];
  version: number;
}

/** A member of a group: the account, and when it joined. The owner is the first, joined when the group was created. */
export interface GroupMember {
  readonly accountId: string;
  readonly joinedAt: Date;
}

/**
 * People who share expenses in one currency, fixed when it is created, owned by the account that created it (ADR 3).
 * Its id is born here, once; its rules are the decision's (`Group.decision.ts`), which checks what it is given before
 * it is made. It holds its members in the order they joined and keeps each account a member once (ADR 4). It carries
 * the version it was loaded at, and its repository refuses to save it over a newer one (CONC-OPTIMISTIC).
 */
export class Group extends AggregateRoot {
  readonly #name: GroupName;
  readonly #currency: Currency;
  readonly #ownerId: string;
  readonly #createdAt: Date;
  readonly #members: GroupMember[];

  private constructor(
    id: Id,
    version: number,
    name: GroupName,
    currency: Currency,
    ownerId: string,
    createdAt: Date,
    members: GroupMember[],
  ) {
    super(id, version);
    this.#name = name;
    this.#currency = currency;
    this.#ownerId = ownerId;
    this.#createdAt = createdAt;
    this.#members = members;
  }

  /** A new group, with its id generated here, its owner as its first member, recording that it was registered at `at`. */
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
    const group = new Group(Id.generate(), 0, name, currency, ownerId, at, [{ accountId: ownerId, joinedAt: at }]);
    group.record(GroupCreatedEvent.set({ groupId: group._id.value, ownerId, createdAt: at }));
    return group;
  }

  /**
   * Rebuilds a group as it was stored, at the version it was stored at. Records nothing, and throws on data no
   * `register()` or `join()` could have made: the owner is a member, first, and the members are all distinct.
   */
  static fromSnapshot(snapshot: GroupSnapshot): Group {
    const name = GroupName.create(snapshot.name);
    const currency = Currency.create(snapshot.currency);
    const createdAt = new Date(snapshot.createdAt);
    const members = snapshot.members.map(member => ({
      accountId: member.accountId,
      joinedAt: new Date(member.joinedAt),
    }));
    const corrupted =
      name.isFailure() ||
      currency.isFailure() ||
      Number.isNaN(createdAt.getTime()) ||
      members[0]?.accountId !== snapshot.ownerId ||
      members.some(member => Number.isNaN(member.joinedAt.getTime())) ||
      new Set(members.map(member => member.accountId)).size !== members.length;
    if (corrupted) throw new Error(`The stored group ${snapshot.id} is corrupted`);
    return new Group(
      new Id(snapshot.id),
      snapshot.version,
      name.data!,
      currency.data!,
      snapshot.ownerId,
      createdAt,
      members,
    );
  }

  /**
   * An account joins the group at `at`, as the last member. Refused when it is a member already; recorded as
   * `MemberJoined` otherwise.
   */
  join(accountId: string, at: Date): IResult<void> {
    if (this.hasMember(accountId)) return Result.fail(new AlreadyMemberException());
    this.#members.push({ accountId, joinedAt: at });
    this.record(MemberJoinedEvent.set({ groupId: this._id.value, accountId, joinedAt: at }));
    return Result.ok(undefined);
  }

  hasMember(accountId: string): boolean {
    return this.#members.some(member => member.accountId === accountId);
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

  /** The members, in the order they joined: the owner first. */
  get members(): readonly GroupMember[] {
    return [...this.#members];
  }

  toSnapshot(): GroupSnapshot {
    return {
      id: this._id.value,
      name: this.#name.value,
      currency: this.#currency.value,
      ownerId: this.#ownerId,
      createdAt: this.#createdAt.toISOString(),
      members: this.#members.map(member => ({
        accountId: member.accountId,
        joinedAt: member.joinedAt.toISOString(),
      })),
      version: this.version,
    };
  }
}
