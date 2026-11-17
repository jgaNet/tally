import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import { GroupSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';
import { AlreadyMember } from '@Contexts/Groups/Domain/Group/GroupExceptions';
import { GroupCreatedEvent, MemberJoinedEvent } from '@Contexts/Groups/Domain/Group/Events/GroupEvents';

/** An account in a group, from the moment it joined: the owner's is the group's creation. */
export interface Membership {
  readonly accountId: Id;
  readonly joinedAt: Date;
}

/**
 * A group: the people who share expenses in one currency. It is made by `create()`, which records the fact, and its
 * owner is its first member: the owner's membership is not a fact of its own (MemberJoined is for the members who
 * join later). The name and the currency are fixed when it is made; nothing here changes them.
 */
export class Group extends AggregateRoot {
  private constructor(
    id: Id,
    version: number,
    readonly name: GroupName,
    readonly currency: Currency,
    readonly ownerId: Id,
    private _members: Membership[],
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
    const group = new Group(Id.generate(), 0, name, currency, ownerId, [{ accountId: ownerId, joinedAt: at }], at);
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
   * Adds an account as a member, from now on. It is refused when the account is already a member: a group is joined
   * once per account, however many invitations lead to it. Records MemberJoined.
   */
  join(accountId: Id, at: Date): IResult {
    if (this.hasMember(accountId)) return Result.fail(new AlreadyMember());
    this._members = [...this._members, { accountId, joinedAt: at }];
    this.record(
      MemberJoinedEvent.set({
        groupId: this._id.value,
        accountId: accountId.value,
        joinedAt: at.toISOString(),
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
      !snapshot.members.some(member => member.accountId === snapshot.ownerId) ||
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
      snapshot.members.map(member => ({ accountId: new Id(member.accountId), joinedAt: new Date(member.joinedAt) })),
      createdAt,
    );
  }

  /** The members in the order they joined, the owner first. */
  get members(): readonly Membership[] {
    return this._members;
  }

  /** Whether this account is one of the group's members: the only people who may see it. */
  hasMember(accountId: Id): boolean {
    return this._members.some(member => member.accountId.equals(accountId));
  }

  toSnapshot(): GroupSnapshot {
    return {
      id: this._id.value,
      name: this.name.value,
      currency: this.currency.value,
      ownerId: this.ownerId.value,
      members: this._members.map(member => ({
        accountId: member.accountId.value,
        joinedAt: member.joinedAt.toISOString(),
      })),
      createdAt: this.createdAt.toISOString(),
      version: this.version,
    };
  }
}
