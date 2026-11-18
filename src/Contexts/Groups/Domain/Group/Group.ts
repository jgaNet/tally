import {
  AggregateRoot,
  AlreadyExistsException,
  Id,
  IResult,
  NotAllowedException,
  NotFoundException,
  Result,
} from '@Architecture/Domain';
import { GroupArchivedException } from '@SharedKernel/Domain';

import {
  BalancePassedEvent,
  GroupArchivedEvent,
  GroupCreatedEvent,
  GroupsMergedEvent,
  MemberJoinedEvent,
  MemberLeftEvent,
} from '@Contexts/Groups/Domain/Group/Events/GroupEvents';
import {
  BalancesNotZeroException,
  CurrenciesDifferException,
  MergeIntoItselfException,
  MergePaymentsWaitingException,
  OwnerCannotLeaveException,
  PaymentsWaitingException,
  PaymentWaitingException,
} from '@Contexts/Groups/Domain/Group/GroupExceptions';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import { Currency, CurrencyCode } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupSnapshot, MemberSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';

/**
 * A balance that passed to the owner when a member left, as the group's audit keeps it (request 28, docs/adr/0027): the member who left
 * (`memberId`, the one who acted and the subject alike), its balance as it left (`amount`, positive or negative) and when.
 */
export interface PassedLeave {
  id: string;
  memberId: string;
  amount: number;
  at: string;
}

/** Sets what a membership passed to the owner in total: a membership that passed nothing keeps no `passed` (docs/adr/0019). */
function setPassed(member: MemberSnapshot, passed: number): void {
  if (passed === 0) delete member.passed;
  else member.passed = passed;
}

/**
 * A group of people who share expenses in one currency (conventions/domain.yaml, the Groups context).
 *
 * Its members are kept in the order they joined; the owner is the first, and the group starts with it: creating
 * a group records GroupCreated, which says who created it, and no MemberJoined (the storm, hot spot 1). The
 * currency is set here and never changes (hot spot 2).
 *
 * A member who leaves (request 9, docs/adr/0009) is kept in the snapshot with `leftAt`, so that who has ever been a member is
 * known; it is no longer among `members`. Joining again puts the account last, as a new member.
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
  #archivedAt: Date | undefined;
  #passedLeaves: PassedLeave[] = [];

  private constructor(
    id: Id,
    name: GroupName,
    currency: Currency,
    ownerId: string,
    createdAt: Date,
    members: MemberSnapshot[],
    archivedAt: Date | undefined,
    version: number,
  ) {
    super(id, version);
    this.#name = name;
    this.#currency = currency;
    this.#ownerId = ownerId;
    this.#createdAt = createdAt;
    this.#members = members;
    this.#archivedAt = archivedAt;
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
      undefined,
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
      snapshot.archivedAt === undefined ? undefined : new Date(snapshot.archivedAt),
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
      ...(this.#archivedAt === undefined ? {} : { archivedAt: this.#archivedAt.toISOString() }),
      version: this.version,
    };
  }

  /**
   * Adds an account as a member, once: it joins at `at`, last of the members, and MemberJoined is recorded for the
   * store to make durable with it. An account that is a member already is refused (AlreadyExists): it cannot join
   * again. An account that left before joins again as a new member, last of them, its former entry replaced. Who may
   * join is decided by the invitation, not here: the use case has checked it.
   */
  join({ accountId, at }: { accountId: string; at: Date }): IResult<undefined> {
    if (this.#archivedAt !== undefined) return Result.fail(new GroupArchivedException('Groups'));
    if (this.isMember(accountId)) {
      return Result.fail(new AlreadyExistsException('Groups', 'You are already a member of this group'));
    }
    const former = this.#members.findIndex(member => member.accountId === accountId);
    // What its earlier leaves passed to the owner stays on the membership: a member who joins again starts at 0 (docs/adr/0019).
    const passed = former === -1 ? undefined : this.#members[former].passed;
    if (former !== -1) this.#members.splice(former, 1);
    this.#members.push({ accountId, role: 'member', joinedAt: at.toISOString(), ...(passed ? { passed } : {}) });
    this.record(MemberJoinedEvent.set({ groupId: this._id.value, accountId }));
    return Result.ok(undefined);
  }

  /**
   * Takes a member out of the group, at whatever its balance (request 20, docs/adr/0019). Only a current member may leave: for
   * anyone else the group does not exist. The owner never leaves, and not while a payment of the member waits at the provider
   * (`waitingPayment`, read by the use case in the same transaction). Its `balance` passes to the owner in the same step:
   * BalancePassed and MemberLeft are recorded for the store to make durable with the departure.
   */
  leave({
    accountId,
    balance,
    waitingPayment,
    at,
  }: {
    accountId: string;
    balance: number;
    waitingPayment: boolean;
    at: Date;
  }): IResult<undefined> {
    const member = this.#members.find(entry => entry.accountId === accountId && entry.leftAt === undefined);
    if (!member) return Result.fail(new NotFoundException('Groups', 'There is no such group'));
    if (this.#archivedAt !== undefined) return Result.fail(new GroupArchivedException('Groups'));
    if (accountId === this.#ownerId) return Result.fail(new OwnerCannotLeaveException());
    if (waitingPayment) return Result.fail(new PaymentWaitingException());
    member.leftAt = at.toISOString();
    if (balance !== 0) {
      member.passed = (member.passed ?? 0) + balance;
      this.#passedLeaves.push({ id: Id.generate().value, memberId: accountId, amount: balance, at: at.toISOString() });
    }
    this.record(
      BalancePassedEvent.set({ groupId: this._id.value, from: accountId, to: this.#ownerId, amount: balance }),
    );
    this.record(MemberLeftEvent.set({ groupId: this._id.value, accountId }));
    return Result.ok(undefined);
  }

  /**
   * Archives the group, for its owner, once every balance in it is 0 and no payment in it waits at the provider (request 27,
   * docs/adr/0026). `balances` are the current members' balances, as Ledger counts them now, and `paymentWaiting` says whether a payment
   * of one of them waits at the provider; both are read by the use case in the same transaction. Refused, and nothing changes: an
   * archived group (`GroupArchived`, archived again too); a `by` that is not the owner (`NotAllowed`); a balance that is not 0; a payment
   * waiting. `at` is the one clock's now. Records GroupArchived, for the store to make durable with it.
   */
  archive({
    by,
    balances,
    paymentWaiting,
    at,
  }: {
    by: string;
    balances: number[];
    paymentWaiting: boolean;
    at: Date;
  }): IResult<undefined> {
    if (this.#archivedAt !== undefined) return Result.fail(new GroupArchivedException('Groups'));
    if (by !== this.#ownerId) {
      return Result.fail(new NotAllowedException('Groups', 'Only the owner of a group may archive it'));
    }
    if (balances.some(balance => balance !== 0)) return Result.fail(new BalancesNotZeroException());
    if (paymentWaiting) return Result.fail(new PaymentsWaitingException());
    this.#archivedAt = at;
    this.record(GroupArchivedEvent.set({ groupId: this._id.value }));
    return Result.ok(undefined);
  }

  /**
   * Merges the group `merged` into this one, which is kept (request 31, docs/adr/0031): the group merged is gone once this is stored. Refused,
   * and nothing changes: a merge into itself; a group archived, either of the two (GroupArchived); a `by` that does not own both groups
   * (NotAllowed); two groups in different currencies; a payment in the group merged waiting at the provider (`paymentWaiting`, read by the
   * use case in the same transaction). Every member of the group merged joins this one at `at`, last, in the order they joined the group
   * merged, with the role `member`: a member of both stays where it is; a former member of the group merged is a former member here, and
   * a member who left here and is one there joins again. What each member passed to the owner, in either group, is added together, so
   * each balance here is what it was here plus what it was there. Records GroupsMerged, for the store to make durable with it.
   */
  absorb({
    merged,
    by,
    paymentWaiting,
    at,
  }: {
    merged: Group;
    by: string;
    paymentWaiting: boolean;
    at: Date;
  }): IResult<undefined> {
    if (merged.id === this.id) return Result.fail(new MergeIntoItselfException());
    if (this.isArchived || merged.isArchived) return Result.fail(new GroupArchivedException('Groups'));
    if (by !== this.#ownerId || by !== merged.ownerId) {
      return Result.fail(new NotAllowedException('Groups', 'Only the owner of both groups may merge them'));
    }
    if (this.currency !== merged.currency) return Result.fail(new CurrenciesDifferException());
    if (paymentWaiting) return Result.fail(new MergePaymentsWaitingException());

    for (const incoming of merged.toSnapshot().members) {
      const index = this.#members.findIndex(member => member.accountId === incoming.accountId);
      const here = index === -1 ? undefined : this.#members[index];
      if (here && here.leftAt === undefined) {
        // A member of both stays where it is; what it passed in either group is what it passed here.
        setPassed(here, (here.passed ?? 0) + (incoming.passed ?? 0));
        continue;
      }
      const passed = (here?.passed ?? 0) + (incoming.passed ?? 0);
      if (index !== -1) this.#members.splice(index, 1);
      this.#members.push({
        accountId: incoming.accountId,
        role: 'member',
        joinedAt: at.toISOString(),
        ...(incoming.leftAt === undefined ? {} : { leftAt: incoming.leftAt }),
        ...(passed === 0 ? {} : { passed }),
      });
    }
    this.record(GroupsMergedEvent.set({ keptGroupId: this._id.value, mergedGroupId: merged.id }));
    return Result.ok(undefined);
  }

  /** Whether an account is a current member of this group, whatever its role. */
  isMember(accountId: string): boolean {
    return this.#members.some(member => member.accountId === accountId && member.leftAt === undefined);
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

  /** Whether the group is archived (request 27): nothing in it changes any more. */
  get isArchived(): boolean {
    return this.#archivedAt !== undefined;
  }

  /** ISO 8601, UTC: when the group was archived, or `undefined` while it is not. */
  get archivedAt(): string | undefined {
    return this.#archivedAt?.toISOString();
  }

  /** The current members, in the order they joined: a former member is not among them. */
  get members(): readonly MemberSnapshot[] {
    return this.#members.filter(member => member.leftAt === undefined).map(member => ({ ...member }));
  }

  /** The balances that passed to the owner since the group was read, in the order they passed: the store writes each one to the audit. */
  get passedLeaves(): readonly PassedLeave[] {
    return this.#passedLeaves;
  }
}
