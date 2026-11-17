import { AggregateRoot, DomainEvent, Id, IResult, Result } from '@Architecture/Domain';

import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import {
  AlreadyMemberException,
  BalanceNotZeroException,
  GroupNotFoundException,
  OwnerCannotLeaveException,
} from '@Contexts/Groups/Domain/Group/GroupExceptions';

/**
 * A group, as the domain keeps it: people who share expenses in one currency, fixed when it is created, owned by the
 * account that created it, whose members are kept in the order they joined, the owner first (conventions/domain.yaml,
 * ADR 5, feature 3). It is an aggregate root because the Lite trigger for it is taken by ADR 5; nothing else in the
 * aggregate changes its currency.
 *
 * A member who leaves (feature 9) is no longer among `members`, and is kept in `formerMembers` with when they left: the
 * group's statements still read them, and a member who joins again becomes the last of `members` once more.
 */
export class Group extends AggregateRoot {
  readonly #name: GroupName;
  readonly #currency: Currency;
  readonly #ownerId: string;
  readonly #members: GroupMember[];
  readonly #formerMembers: FormerMember[];
  readonly #createdAt: string;

  private constructor(
    id: Id,
    name: GroupName,
    currency: Currency,
    ownerId: string,
    members: GroupMember[],
    formerMembers: FormerMember[],
    createdAt: string,
    version: number,
  ) {
    super(id, version);
    this.#name = name;
    this.#currency = currency;
    this.#ownerId = ownerId;
    this.#members = members;
    this.#formerMembers = formerMembers;
    this.#createdAt = createdAt;
  }

  /** The account that created the group. */
  get ownerId(): string {
    return this.#ownerId;
  }

  /** The members in the order they joined, the owner first. A copy: the aggregate keeps its own list. */
  members(): GroupMember[] {
    return this.#members.map(member => ({ ...member }));
  }

  /** The members who have left, with when each joined and when it left. A copy: the aggregate keeps its own list. */
  formerMembers(): FormerMember[] {
    return this.#formerMembers.map(member => ({ ...member }));
  }

  /** Whether the account is one of the group's members now. */
  hasMember(accountId: string): boolean {
    return this.#members.some(member => member.accountId === accountId);
  }

  /**
   * A creation: the name and the currency must be ones the domain allows, the owner is the account that asks and is the
   * group's first member. The identity is generated here (DOMAIN-IDENTITY), and the creation records GroupCreated. Pure:
   * the time is `now`. Named `register`, as the contract allows for a creation (ADR 5): the inventory matches a behaviour
   * by its name in any call, so two aggregates' `create` would be taken for one another.
   */
  static register({ name, currency, ownerId }: GroupDraft, now: Date): IResult<Group> {
    const groupName = GroupName.create(name);
    if (groupName.isFailure()) return Result.fail(groupName.error);

    const groupCurrency = Currency.create(currency);
    if (groupCurrency.isFailure()) return Result.fail(groupCurrency.error);

    const id = Id.generate();
    const at = now.toISOString();
    const group = new Group(
      id,
      groupName.data,
      groupCurrency.data,
      ownerId,
      [{ accountId: ownerId, joinedAt: at }],
      [],
      at,
      0,
    );
    group.record(GroupCreatedEvent.set({ groupId: id.value, createdBy: ownerId, at }));
    return Result.ok(group);
  }

  /**
   * An account joins the group (feature 3): once only, and it becomes the last of the members. Refused with
   * `AlreadyMember` when it is one already. An account that left before (feature 9) is a member again from now: it leaves
   * its former row and joins last, with the balance its earlier expenses gave it. Records MemberJoined; the time is `now`.
   */
  join(accountId: string, now: Date): IResult<void> {
    if (this.hasMember(accountId)) return Result.fail(new AlreadyMemberException());

    const at = now.toISOString();
    const index = this.#formerMembers.findIndex(member => member.accountId === accountId);
    if (index >= 0) this.#formerMembers.splice(index, 1);
    this.#members.push({ accountId, joinedAt: at });
    this.record(MemberJoinedEvent.set({ groupId: this._id.value, accountId, at }));
    return Result.ok(undefined);
  }

  /**
   * A member leaves the group (feature 9): the owner never does, and a member does only once their balance in it is 0,
   * which the caller reads from Ledger and gives here as a plain value. A member who is not one of the group is not there
   * for them: `404`. Records MemberLeft; the time is `now`. Pure.
   */
  leave(accountId: string, balance: number, now: Date): IResult<void> {
    if (accountId === this.#ownerId) return Result.fail(new OwnerCannotLeaveException());

    const member = this.#members.find(candidate => candidate.accountId === accountId);
    if (!member) return Result.fail(new GroupNotFoundException());
    if (balance !== 0) return Result.fail(new BalanceNotZeroException());

    const at = now.toISOString();
    this.#members.splice(this.#members.indexOf(member), 1);
    this.#formerMembers.push({ accountId, joinedAt: member.joinedAt, leftAt: at });
    this.record(MemberLeftEvent.set({ groupId: this._id.value, accountId, at }));
    return Result.ok(undefined);
  }

  /** The group as the store keeps it. Records nothing; throws on a snapshot that is not a group the domain accepts. */
  static fromSnapshot(snapshot: GroupSnapshot): Group {
    const name = GroupName.create(snapshot.name);
    const currency = Currency.create(snapshot.currency);
    if (name.isFailure() || currency.isFailure() || snapshot.members[0]?.accountId !== snapshot.ownerId) {
      throw new Error(`The group ${snapshot.id} is corrupted: its name, currency or first member is not the domain's`);
    }
    return new Group(
      new Id(snapshot.id),
      name.data,
      currency.data,
      snapshot.ownerId,
      snapshot.members.map(member => ({ ...member })),
      snapshot.formerMembers.map(member => ({ ...member })),
      snapshot.createdAt,
      snapshot.version,
    );
  }

  toSnapshot(): GroupSnapshot {
    return {
      id: this._id.value,
      name: this.#name.value,
      currency: this.#currency.value,
      ownerId: this.#ownerId,
      members: this.members(),
      formerMembers: this.formerMembers(),
      createdAt: this.#createdAt,
      version: this.version,
    };
  }
}

/** What a creation gives the aggregate: the typed values, and the account that creates the group. */
export interface GroupDraft {
  readonly name: string;
  readonly currency: string;
  readonly ownerId: string;
}

/** A member of a group: the account, and when it joined (the owner, when the group was created). */
export interface GroupMember {
  readonly accountId: string;
  readonly joinedAt: string;
}

/** A member who has left a group: the account, when it joined, and when it left (feature 9). */
export interface FormerMember extends GroupMember {
  readonly leftAt: string;
}

/**
 * A group as the store keeps it, its version included. `members` starts with the owner, in the order they joined, and holds
 * the members now; `formerMembers` holds those who have left.
 */
export interface GroupSnapshot {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly ownerId: string;
  readonly members: readonly GroupMember[];
  readonly formerMembers: readonly FormerMember[];
  readonly createdAt: string;
  readonly version: number;
}

export type GroupCreatedPayload = { groupId: string; createdBy: string; at: string };

/**
 * The fact of a creation (ADR 5): who created the group, and when. It is made durable with the group and published after
 * the commit; nothing subscribes to it yet.
 */
export class GroupCreatedEvent extends DomainEvent<GroupCreatedPayload> {}

export type MemberJoinedPayload = { groupId: string; accountId: string; at: string };

/**
 * The fact of a join (feature 3): which account joined which group, and when. It is made durable with the group and
 * published after the commit; nothing subscribes to it (no integration event, T3 in ADR 1).
 */
export class MemberJoinedEvent extends DomainEvent<MemberJoinedPayload> {}

export type MemberLeftPayload = { groupId: string; accountId: string; at: string };

/**
 * The fact of a leave (feature 9): which account left which group, and when. It is made durable with the group and published
 * after the commit; nothing subscribes to it (Ledger reads the members when it decides, as for joining).
 */
export class MemberLeftEvent extends DomainEvent<MemberLeftPayload> {}
