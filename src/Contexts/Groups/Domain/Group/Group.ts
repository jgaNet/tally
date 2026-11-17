import { AggregateRoot, Id } from '@Architecture/Domain';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import { GroupSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';
import { GroupCreatedEvent } from '@Contexts/Groups/Domain/Group/Events/GroupEvents';

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
    readonly memberIds: readonly Id[],
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
    const group = new Group(Id.generate(), 0, name, currency, ownerId, [ownerId], at);
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
      !snapshot.memberIds.includes(snapshot.ownerId) ||
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
      snapshot.memberIds.map(memberId => new Id(memberId)),
      createdAt,
    );
  }

  /** Whether this account is one of the group's members: the only people who may see it. */
  hasMember(accountId: Id): boolean {
    return this.memberIds.some(memberId => memberId.equals(accountId));
  }

  toSnapshot(): GroupSnapshot {
    return {
      id: this._id.value,
      name: this.name.value,
      currency: this.currency.value,
      ownerId: this.ownerId.value,
      memberIds: this.memberIds.map(memberId => memberId.value),
      createdAt: this.createdAt.toISOString(),
      version: this.version,
    };
  }
}
