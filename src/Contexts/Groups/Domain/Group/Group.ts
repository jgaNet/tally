import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { GroupSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';
import { GroupCreatedEvent, MemberJoinedEvent } from '@Contexts/Groups/Domain/Group/Events/GroupEvents';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import { AlreadyAMember } from '@Contexts/Groups/Domain/Group/GroupExceptions';

/** One member of a group: an account, from the moment it joined. */
export interface Membership {
  accountId: Id;
  joinedAt: Date;
}

/**
 * A group of people who share expenses, in one currency fixed when it is created and never changed. Its owner is its
 * first member; whoever joins later joins by an invitation, once, and a group's members are the only ones who may see it.
 */
export class Group extends AggregateRoot {
  private constructor(
    id: Id,
    readonly name: GroupName,
    readonly currency: Currency,
    readonly ownerId: Id,
    /** The members in the order they joined; the owner is the first. */
    readonly members: Membership[],
    readonly createdAt: Date,
    version: number,
  ) {
    super(id, version);
  }

  /** `now` is the application's clock, read by the handler: the group's creation time is a parameter, never a default. */
  static create({
    name,
    currency,
    ownerId,
    now,
  }: {
    name: GroupName;
    currency: Currency;
    ownerId: Id;
    now: Date;
  }): Group {
    const group = new Group(Id.generate(), name, currency, ownerId, [{ accountId: ownerId, joinedAt: now }], now, 0);
    group.record(GroupCreatedEvent.set({ groupId: group._id.value, ownerId: ownerId.value }));
    return group;
  }

  static fromSnapshot(snapshot: GroupSnapshot): Group {
    const name = GroupName.create(snapshot.name);
    const currency = Currency.create(snapshot.currency);
    const createdAt = new Date(snapshot.createdAt);
    const joinedAt = snapshot.members.map(member => new Date(member.joinedAt));
    if (
      name.isFailure() ||
      currency.isFailure() ||
      Number.isNaN(createdAt.getTime()) ||
      !snapshot.members.length ||
      snapshot.members[0].accountId !== snapshot.ownerId ||
      joinedAt.some(date => Number.isNaN(date.getTime()))
    ) {
      throw new Error(`The group ${snapshot.id} is corrupted`);
    }
    return new Group(
      new Id(snapshot.id),
      name.data,
      currency.data,
      new Id(snapshot.ownerId),
      snapshot.members.map((member, index) => ({ accountId: new Id(member.accountId), joinedAt: joinedAt[index] })),
      createdAt,
      snapshot.version,
    );
  }

  /** Whether this account is one of the group's members: the owner, or whoever joined. */
  isMember(accountId: Id): boolean {
    return this.members.some(member => member.accountId.value === accountId.value);
  }

  /**
   * The account joins the group as its newest member, at `now`, the application's clock. Refused when it is already a
   * member: an account is a member of a group once.
   */
  join({ accountId, now }: { accountId: Id; now: Date }): IResult {
    if (this.isMember(accountId)) return Result.fail(new AlreadyAMember());
    this.members.push({ accountId, joinedAt: now });
    this.record(MemberJoinedEvent.set({ groupId: this._id.value, accountId: accountId.value }));
    return Result.ok();
  }

  toSnapshot(): GroupSnapshot {
    return {
      id: this._id.value,
      name: this.name.value,
      currency: this.currency.value,
      ownerId: this.ownerId.value,
      members: this.members.map(member => ({
        accountId: member.accountId.value,
        joinedAt: member.joinedAt.toISOString(),
      })),
      createdAt: this.createdAt.toISOString(),
      version: this.version,
    };
  }
}
