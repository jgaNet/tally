import { AggregateRoot, IResult, Id, Result } from '@Architecture/Domain';

import { IGroupSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import { AlreadyMemberException } from '@Contexts/Groups/Domain/Group/GroupExceptions';
import { GroupCreatedEvent, MemberJoinedEvent } from '@Contexts/Groups/Domain/Group/Events/GroupEvents';

/** A member of a group: the account, and when it joined. */
export interface GroupMember {
  accountId: string;
  joinedAt: Date;
}

/**
 * Group is the aggregate root of Groups' groups: the people who share expenses in one currency, fixed when the
 * group is created (the storm's decision). Its creator is its owner and its first member. Other accounts join by an
 * invitation (request 3), and each account is a member once: the group keeps that, since it is the one place the
 * membership lives.
 *
 * The name and the currency are value objects, validated by their own `create()`, so a group once held is valid.
 * The name is the only thing that changes after the creation, and no behaviour here changes it; the behaviours are
 * the creation, which records GroupCreated, and a join, which records MemberJoined.
 */
export class Group extends AggregateRoot {
  readonly #name: GroupName;
  readonly #currency: Currency;
  readonly #ownerId: string;
  readonly #members: GroupMember[];
  readonly #createdAt: Date;

  private constructor(
    id: Id,
    name: GroupName,
    currency: Currency,
    ownerId: string,
    members: GroupMember[],
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

    const group = new Group(
      Id.generate(),
      validName.data,
      validCurrency.data,
      ownerId,
      [{ accountId: ownerId, joinedAt: createdAt }],
      createdAt,
      0,
    );
    group.record(GroupCreatedEvent.set({ groupId: group._id.value, ownerId }));
    return Result.ok(group);
  }

  /**
   * An account joins the group: it becomes its last member, at the time given, and MemberJoined is recorded. Refused
   * with AlreadyMember when the account is one of its members already; a member is never added twice.
   */
  join({ accountId, joinedAt }: { accountId: string; joinedAt: Date }): IResult<void> {
    if (this.isMember(accountId)) return Result.fail(new AlreadyMemberException());

    this.#members.push({ accountId, joinedAt });
    this.record(MemberJoinedEvent.set({ groupId: this._id.value, accountId }));
    return Result.ok();
  }

  /** Whether this account is one of the group's members. */
  isMember(accountId: string): boolean {
    return this.#members.some(member => member.accountId === accountId);
  }

  /** Rebuilds a group from what was persisted. Nothing is recorded: nothing new happened. */
  static fromSnapshot(snapshot: IGroupSnapshot): Group {
    const name = GroupName.create(snapshot.name);
    const currency = Currency.create(snapshot.currency);
    const createdAt = new Date(snapshot.createdAt);
    const members = snapshot.members.map(member => ({
      accountId: member.accountId,
      joinedAt: new Date(member.joinedAt),
    }));
    if (
      name.isFailure() ||
      currency.isFailure() ||
      !members.some(member => member.accountId === snapshot.ownerId) ||
      new Set(members.map(member => member.accountId)).size !== members.length ||
      members.some(member => Number.isNaN(member.joinedAt.getTime())) ||
      Number.isNaN(createdAt.getTime())
    ) {
      throw new Error(`Corrupted group ${snapshot._id}`);
    }
    return new Group(
      new Id(snapshot._id),
      name.data,
      currency.data,
      snapshot.ownerId,
      members,
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
      members: this.#members.map(member => ({ accountId: member.accountId, joinedAt: member.joinedAt.toISOString() })),
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

  /** The members in the order they joined: the owner first. */
  get members(): readonly GroupMember[] {
    return this.#members;
  }

  get createdAt(): Date {
    return this.#createdAt;
  }
}
