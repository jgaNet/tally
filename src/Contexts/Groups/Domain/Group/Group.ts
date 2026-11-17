import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import { GroupSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';
import {
  AlreadyMember,
  BalanceNotZero,
  NotAMember,
  OwnerCannotLeave,
} from '@Contexts/Groups/Domain/Group/GroupExceptions';
import {
  GroupCreatedEvent,
  MemberJoinedEvent,
  MemberLeftEvent,
} from '@Contexts/Groups/Domain/Group/Events/GroupEvents';

/**
 * An account in a group, from the moment it joined, until the moment it left (`leftAt`, null while it is a member). A
 * former membership stays in the group's record: what its member did in the group is still read through it.
 */
export interface Membership {
  readonly accountId: Id;
  readonly joinedAt: Date;
  readonly leftAt: Date | null;
}

/**
 * A group: the people who share expenses in one currency. It is made by `create()`, which records the fact, and its
 * owner is its first member: the owner's membership is not a fact of its own (MemberJoined is for the members who
 * join later). The name and the currency are fixed when it is made; nothing here changes them. The owner never leaves.
 */
export class Group extends AggregateRoot {
  private constructor(
    id: Id,
    version: number,
    readonly name: GroupName,
    readonly currency: Currency,
    readonly ownerId: Id,
    private _memberships: Membership[],
    readonly createdAt: Date,
  ) {
    super(id, version);
  }

  static create({
    name,
    currency,
    ownerId,
    at,
  }: {
    name: GroupName;
    currency: Currency;
    ownerId: Id;
    at: Date;
  }): Group {
    const group = new Group(
      Id.generate(),
      0,
      name,
      currency,
      ownerId,
      [{ accountId: ownerId, joinedAt: at, leftAt: null }],
      at,
    );
    group.record(
      GroupCreatedEvent.set({
        groupId: group._id.value,
        name: name.value,
        currency: currency.value,
        ownerId: ownerId.value,
        createdAt: at.toISOString(),
      }),
    );
    return group;
  }

  /**
   * Adds an account as a member, from now on. It is refused when the account is a member already: a group is joined
   * once per account, however many invitations lead to it. An account that left joins again last, from now on, with
   * the time of this join. Records MemberJoined.
   */
  join(accountId: Id, at: Date): IResult {
    if (this.hasMember(accountId)) return Result.fail(new AlreadyMember());
    this._memberships = [
      ...this._memberships.filter(membership => !membership.accountId.equals(accountId)),
      { accountId, joinedAt: at, leftAt: null },
    ];
    this.record(
      MemberJoinedEvent.set({
        groupId: this._id.value,
        accountId: accountId.value,
        joinedAt: at.toISOString(),
      }),
    );
    return Result.ok();
  }

  /**
   * A member leaves the group. The owner never does, a non-member cannot, and a member leaves only with a balance of 0
   * in the group, which the caller reads from Ledger and gives as a plain value. Records MemberLeft.
   */
  leave({ accountId, balance, at }: { accountId: Id; balance: number; at: Date }): IResult {
    if (accountId.equals(this.ownerId)) return Result.fail(new OwnerCannotLeave());
    if (!this.hasMember(accountId)) return Result.fail(new NotAMember());
    if (balance !== 0) return Result.fail(new BalanceNotZero());
    this._memberships = this._memberships.map(membership =>
      membership.accountId.equals(accountId) ? { ...membership, leftAt: at } : membership,
    );
    this.record(
      MemberLeftEvent.set({
        groupId: this._id.value,
        accountId: accountId.value,
        leftAt: at.toISOString(),
      }),
    );
    return Result.ok();
  }

  /** Reconstitutes a stored group. It records nothing, and refuses corrupted data by throwing. */
  static fromSnapshot(snapshot: GroupSnapshot): Group {
    const name = GroupName.create(snapshot.name);
    const currency = Currency.create(snapshot.currency);
    const createdAt = new Date(snapshot.createdAt);
    if (
      name.isFailure() ||
      currency.isFailure() ||
      !snapshot.id ||
      !snapshot.ownerId ||
      !snapshot.members.some(member => member.accountId === snapshot.ownerId && member.leftAt === null) ||
      Number.isNaN(createdAt.getTime())
    ) {
      throw new Error(`Corrupted group ${snapshot.id}`);
    }
    return new Group(
      new Id(snapshot.id),
      snapshot.version,
      name.data,
      currency.data,
      new Id(snapshot.ownerId),
      snapshot.members.map(member => ({
        accountId: new Id(member.accountId),
        joinedAt: new Date(member.joinedAt),
        leftAt: member.leftAt === null ? null : new Date(member.leftAt),
      })),
      createdAt,
    );
  }

  /** The members, the ones who have not left, in the order they joined, the owner first. */
  get members(): readonly Membership[] {
    return this._memberships.filter(membership => membership.leftAt === null);
  }

  /** Whether this account is a member now: the only people who may see the group. */
  hasMember(accountId: Id): boolean {
    return this.members.some(member => member.accountId.equals(accountId));
  }

  /** Whether this account has ever been a member, and so whose record of the group's expenses is still read. */
  hasBeenMember(accountId: Id): boolean {
    return this._memberships.some(membership => membership.accountId.equals(accountId));
  }

  toSnapshot(): GroupSnapshot {
    return {
      id: this._id.value,
      name: this.name.value,
      currency: this.currency.value,
      ownerId: this.ownerId.value,
      members: this._memberships.map(membership => ({
        accountId: membership.accountId.value,
        joinedAt: membership.joinedAt.toISOString(),
        leftAt: membership.leftAt === null ? null : membership.leftAt.toISOString(),
      })),
      createdAt: this.createdAt.toISOString(),
      version: this.version,
    };
  }
}
