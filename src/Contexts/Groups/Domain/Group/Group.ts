import { AggregateRoot, Id } from '@Architecture/Domain';

import { GroupSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';
import { GroupCreatedEvent } from '@Contexts/Groups/Domain/Group/Events/GroupEvents';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';

/**
 * A group of people who share expenses, in one currency fixed when it is created and never changed. Its owner is its
 * first member: whoever joins later is feature 3's, and a group's members are the only ones who may see it.
 */
export class Group extends AggregateRoot {
  private constructor(
    id: Id,
    readonly name: GroupName,
    readonly currency: Currency,
    readonly ownerId: Id,
    /** The members in the order they joined; the owner is the first. */
    readonly memberIds: Id[],
    readonly createdAt: Date,
  ) {
    super(id);
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
    const group = new Group(Id.generate(), name, currency, ownerId, [ownerId], now);
    group.record(GroupCreatedEvent.set({ groupId: group._id.value, ownerId: ownerId.value }));
    return group;
  }

  static fromSnapshot(snapshot: GroupSnapshot): Group {
    const name = GroupName.create(snapshot.name);
    const currency = Currency.create(snapshot.currency);
    const createdAt = new Date(snapshot.createdAt);
    if (name.isFailure() || currency.isFailure() || Number.isNaN(createdAt.getTime()) || !snapshot.memberIds.length) {
      throw new Error(`The group ${snapshot.id} is corrupted`);
    }
    return new Group(
      new Id(snapshot.id),
      name.data,
      currency.data,
      new Id(snapshot.ownerId),
      snapshot.memberIds.map(memberId => new Id(memberId)),
      createdAt,
    );
  }

  toSnapshot(): GroupSnapshot {
    return {
      id: this._id.value,
      name: this.name.value,
      currency: this.currency.value,
      ownerId: this.ownerId.value,
      memberIds: this.memberIds.map(memberId => memberId.value),
      createdAt: this.createdAt.toISOString(),
    };
  }
}
