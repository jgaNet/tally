import { AggregateRoot, AlreadyExistsException, Id, IResult, Result } from '@Architecture/Domain';

import { GroupCreatedEvent, MemberJoinedEvent } from '@Contexts/Groups/Domain/Group/Events/GroupEvents';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import { Currency, CurrencyCode } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupSnapshot, MemberSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';

/**
 * A group of people who share expenses in one currency (conventions/domain.yaml, the Groups context).
 *
 * Its members are kept in the order they joined; the owner is the first, and the group starts with it: creating
 * a group records GroupCreated, which says who created it, and no MemberJoined (the storm, hot spot 1). The
 * currency is set here and never changes (hot spot 2).
 *
 * `register()` is the creation, which the rule allows under either name (DOMAIN-CREATE-VS-RECONSTITUTE). It is not
 * named `create()` here because the reference's inventory credits any `X.create(` call in a use case to every
 * aggregate of the context with a `create` behaviour (Account's, in Groups). It validates the raw name and currency,
 * generates the id, makes the owner the first member, and records GroupCreated for the store to make durable with it.
 * `fromSnapshot()` reads what the store kept, records nothing, and throws on corrupted data. The store saves the group
 * and checks its version.
 */
export class Group extends AggregateRoot {
  readonly #name: GroupName;
  readonly #currency: Currency;
  readonly #ownerId: string;
  readonly #createdAt: Date;
  readonly #members: MemberSnapshot[];

  private constructor(
    id: Id,
    name: GroupName,
    currency: Currency,
    ownerId: string,
    createdAt: Date,
    members: MemberSnapshot[],
    version: number,
  ) {
    super(id, version);
    this.#name = name;
    this.#currency = currency;
    this.#ownerId = ownerId;
    this.#createdAt = createdAt;
    this.#members = members;
  }

  /**
   * Registers a group for its owner, who is its first member. The name and the currency are validated here, and a
   * value the rules refuse is a failed Result; `at` is the one clock's now, given by the caller.
   */
  static register({
    name,
    currency,
    ownerId,
    at,
  }: {
    name: string;
    currency: string;
    ownerId: string;
    at: Date;
  }): IResult<Group> {
    const groupName = GroupName.create(name);
    if (groupName.isFailure()) return groupName;
    const groupCurrency = Currency.create(currency);
    if (groupCurrency.isFailure()) return groupCurrency;

    const id = Id.generate();
    const group = new Group(
      id,
      groupName.data,
      groupCurrency.data,
      ownerId,
      at,
      [{ accountId: ownerId, role: 'owner', joinedAt: at.toISOString() }],
      0,
    );
    group.record(
      GroupCreatedEvent.set({
        groupId: id.value,
        name: groupName.data.value,
        currency: groupCurrency.data.value,
        ownerId,
      }),
    );
    return Result.ok(group);
  }

  static fromSnapshot(snapshot: GroupSnapshot): Group {
    const name = GroupName.create(snapshot.name);
    const currency = Currency.create(snapshot.currency);
    const createdAt = new Date(snapshot.createdAt);
    if (
      name.isFailure() ||
      currency.isFailure() ||
      Number.isNaN(createdAt.getTime()) ||
      snapshot.members.length === 0 ||
      snapshot.members[0].accountId !== snapshot.ownerId
    ) {
      throw new Error(`The group ${snapshot.id} is corrupted in the store`);
    }
    return new Group(
      new Id(snapshot.id),
      name.data,
      currency.data,
      snapshot.ownerId,
      createdAt,
      snapshot.members.map(member => ({ ...member })),
      snapshot.version,
    );
  }

  toSnapshot(): GroupSnapshot {
    return {
      id: this._id.value,
      name: this.#name.value,
      currency: this.#currency.value,
      ownerId: this.#ownerId,
      createdAt: this.#createdAt.toISOString(),
      members: this.#members.map(member => ({ ...member })),
      version: this.version,
    };
  }

  /**
   * Adds an account as a member, once: it joins at `at`, last of the members, and MemberJoined is recorded for the
   * store to make durable with it. An account that is a member already is refused (AlreadyExists): it cannot join
   * again. Who may join is decided by the invitation, not here: the use case has checked it.
   */
  join({ accountId, at }: { accountId: string; at: Date }): IResult<undefined> {
    if (this.isMember(accountId)) {
      return Result.fail(new AlreadyExistsException('Groups', 'You are already a member of this group'));
    }
    this.#members.push({ accountId, role: 'member', joinedAt: at.toISOString() });
    this.record(MemberJoinedEvent.set({ groupId: this._id.value, accountId }));
    return Result.ok(undefined);
  }

  /** Whether an account is a member of this group, whatever its role. */
  isMember(accountId: string): boolean {
    return this.#members.some(member => member.accountId === accountId);
  }

  get id(): string {
    return this._id.value;
  }

  get name(): string {
    return this.#name.value;
  }

  get currency(): CurrencyCode {
    return this.#currency.value;
  }

  get ownerId(): string {
    return this.#ownerId;
  }

  /** The members, in the order they joined. */
  get members(): readonly MemberSnapshot[] {
    return this.#members.map(member => ({ ...member }));
  }
}
