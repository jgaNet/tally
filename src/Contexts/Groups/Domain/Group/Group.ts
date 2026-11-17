import { AggregateRoot, IResult, Id, Result } from '@Architecture/Domain';

import { IGroupSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import { GroupCreatedEvent } from '@Contexts/Groups/Domain/Group/Events/GroupEvents';

/**
 * Group is the aggregate root of Groups' groups: the people who share expenses in one currency, fixed when the
 * group is created (the storm's decision). Its creator is its owner and its first member; nothing in this feature
 * adds a member, so the members are the owner alone until a later request joins one.
 *
 * The name and the currency are value objects, validated by their own `create()`, so a group once held is valid.
 * Nothing changes after the creation, so the only behaviour is the creation itself, which records GroupCreated.
 */
export class Group extends AggregateRoot {
  readonly #name: GroupName;
  readonly #currency: Currency;
  readonly #ownerId: string;
  readonly #members: string[];
  readonly #createdAt: Date;

  private constructor(
    id: Id,
    name: GroupName,
    currency: Currency,
    ownerId: string,
    members: string[],
    createdAt: Date,
    version: number,
  ) {
    super(id, version);
    this.#name = name;
    this.#currency = currency;
    this.#ownerId = ownerId;
    this.#members = members;
    this.#createdAt = createdAt;
  }

  /**
   * Founds a new group: the name and the currency are validated here, its id is generated, its owner is its first
   * member, and the creation is recorded. Refused with the value's own exception when a value is not allowed. The
   * time is the one the application passes; there is no default (DOMAIN-ONE-CLOCK).
   *
   * Named `found`, not `create`: the storm reader attributes a create call to any aggregate of the context, so the
   * Account aggregate would be named the owner of this command. The behaviour is a creation all the same.
   */
  static found({
    name,
    currency,
    ownerId,
    createdAt,
  }: {
    name: string;
    currency: string;
    ownerId: string;
    createdAt: Date;
  }): IResult<Group> {
    const validName = GroupName.create(name);
    if (validName.isFailure()) return Result.fail(validName.error);
    const validCurrency = Currency.create(currency);
    if (validCurrency.isFailure()) return Result.fail(validCurrency.error);

    const group = new Group(Id.generate(), validName.data, validCurrency.data, ownerId, [ownerId], createdAt, 0);
    group.record(GroupCreatedEvent.set({ groupId: group._id.value, ownerId }));
    return Result.ok(group);
  }

  /** Rebuilds a group from what was persisted. Nothing is recorded: nothing new happened. */
  static fromSnapshot(snapshot: IGroupSnapshot): Group {
    const name = GroupName.create(snapshot.name);
    const currency = Currency.create(snapshot.currency);
    const createdAt = new Date(snapshot.createdAt);
    if (
      name.isFailure() ||
      currency.isFailure() ||
      !snapshot.members.includes(snapshot.ownerId) ||
      Number.isNaN(createdAt.getTime())
    ) {
      throw new Error(`Corrupted group ${snapshot._id}`);
    }
    return new Group(
      new Id(snapshot._id),
      name.data,
      currency.data,
      snapshot.ownerId,
      [...snapshot.members],
      createdAt,
      snapshot.version,
    );
  }

  toSnapshot(): IGroupSnapshot {
    return {
      _id: this._id.value,
      name: this.#name.value,
      currency: this.#currency.value,
      ownerId: this.#ownerId,
      members: [...this.#members],
      createdAt: this.#createdAt.toISOString(),
      version: this.version,
    };
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

  get members(): readonly string[] {
    return this.#members;
  }

  get createdAt(): Date {
    return this.#createdAt;
  }
}
