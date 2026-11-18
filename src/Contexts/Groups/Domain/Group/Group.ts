import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { GroupArchived } from '@SharedKernel/Domain';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import { GroupSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';
import {
  AlreadyMember,
  CurrenciesDiffer,
  GroupMergedIntoItself,
  GroupNotSettled,
  NotAMember,
  OnlyTheOwnerMerges,
  OnlyTheOwnerArchives,
  OwnerCannotLeave,
  PaymentWaitingAtProvider,
} from '@Contexts/Groups/Domain/Group/GroupExceptions';
import {
  BalancePassedEvent,
  GroupArchivedEvent,
  GroupCreatedEvent,
  GroupsMergedEvent,
  MemberJoinedEvent,
  MemberLeftEvent,
} from '@Contexts/Groups/Domain/Group/Events/GroupEvents';
import { PassedBalanceSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';

/** A balance that passed from the member who left to the owner, in the same step as the leave (request 20). */
export interface PassedBalance {
  readonly fromId: Id;
  readonly toId: Id;
  readonly amount: number;
  readonly passedAt: Date;
  /** The key it was born with in another group, `<group>:<position>`, when a merge brought it here (request 31); null otherwise. */
  readonly origin: string | null;
}

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
 * join later). The name and the currency are fixed when it is made; nothing here changes them. The owner never leaves,
 * and what a member who leaves owed or was owed passes to the owner (BalancePassed, request 20). Once archived (request 27),
 * the group is read only: every change in it is refused by GroupArchived, and the archive is never undone.
 */
export class Group extends AggregateRoot {
  private constructor(
    id: Id,
    version: number,
    readonly name: GroupName,
    readonly currency: Currency,
    readonly ownerId: Id,
    private _memberships: Membership[],
    private _passed: PassedBalance[],
    readonly createdAt: Date,
    private _archivedAt: Date | null = null,
    private _mergedInto: Id | null = null,
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
      [],
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
   * Refuses a change in the group once it is archived (request 27, ADR 20): every behaviour that would change something in
   * the group asks this first, and answers its refusal by GroupArchived, the one rule's name.
   */
  mayChange(): IResult {
    return this._archivedAt === null ? Result.ok() : Result.fail(new GroupArchived());
  }

  /**
   * Archives the group (request 27): only its owner, once every member's balance is 0 and no payment of any member waits at
   * the provider. The balances and whether a payment waits are read by the caller and given as plain values, in the same
   * transaction. Once archived, the group is read only. Records GroupArchived.
   */
  archive({
    accountId,
    balances,
    paymentWaiting,
    at,
  }: {
    accountId: Id;
    balances: readonly number[];
    paymentWaiting: boolean;
    at: Date;
  }): IResult {
    const open = this.mayChange();
    if (open.isFailure()) return open;
    if (!accountId.equals(this.ownerId)) return Result.fail(new OnlyTheOwnerArchives());
    if (balances.some(balance => balance !== 0)) return Result.fail(new GroupNotSettled());
    if (paymentWaiting) return Result.fail(new PaymentWaitingAtProvider());
    this._archivedAt = at;
    this.record(
      GroupArchivedEvent.set({
        groupId: this._id.value,
        archivedAt: at.toISOString(),
      }),
    );
    return Result.ok();
  }

  /**
   * Merges another group, the group merged, into this one, the group kept (request 31, ADR 23). Only the owner of both, two
   * groups that are not one, of one currency, neither archived (GroupArchived), and no payment waiting at the provider in the
   * group merged, read by the caller and given as a plain value. Every member of the group merged who is not a member here
   * joins now, after the members, in the order they joined it, as a member; one who had left it is a former member here, unless
   * they have been one of this group already; a member of both stays where they are. What passed to its owner when its members
   * left is this group's from now on, each keeping the key it was born with. The group merged is closed in the same step: it no
   * longer exists, and records nothing. Records GroupsMerged, which tells the other contexts to move what they hold of it.
   */
  merge({
    merged,
    accountId,
    paymentWaiting,
    at,
  }: {
    merged: Group;
    accountId: Id;
    paymentWaiting: boolean;
    at: Date;
  }): IResult {
    const open = this.mayChange();
    if (open.isFailure()) return open;
    const mergedOpen = merged.mayChange();
    if (mergedOpen.isFailure()) return mergedOpen;
    if (!accountId.equals(this.ownerId) || !accountId.equals(merged.ownerId)) {
      return Result.fail(new OnlyTheOwnerMerges());
    }
    if (merged._id.equals(this._id)) return Result.fail(new GroupMergedIntoItself());
    if (merged.currency.value !== this.currency.value) return Result.fail(new CurrenciesDiffer());
    if (paymentWaiting) {
      return Result.fail(
        new PaymentWaitingAtProvider('A group is merged once no payment in it is waiting at the provider'),
      );
    }

    for (const membership of merged._memberships) {
      if (this.hasMember(membership.accountId)) continue;
      if (membership.leftAt === null) {
        this._memberships = [
          ...this._memberships.filter(current => !current.accountId.equals(membership.accountId)),
          { accountId: membership.accountId, joinedAt: at, leftAt: null },
        ];
      } else if (!this.hasBeenMember(membership.accountId)) {
        this._memberships = [...this._memberships, membership];
      }
    }
    this._passed = [
      ...this._passed,
      ...merged._passed.map((passed, position) => ({
        ...passed,
        origin: passed.origin ?? `${merged._id.value}:${position}`,
      })),
    ];
    merged._mergedInto = this._id;
    this.record(
      GroupsMergedEvent.set({
        groupId: this._id.value,
        mergedGroupId: merged._id.value,
        ownerId: this.ownerId.value,
        mergedAt: at.toISOString(),
      }),
    );
    return Result.ok();
  }

  /** The group this one was merged into, once it is (request 31): it no longer exists, and its repository forgets it. */
  get mergedInto(): Id | null {
    return this._mergedInto;
  }

  /**
   * Adds an account as a member, from now on. It is refused when the account is a member already: a group is joined
   * once per account, however many invitations lead to it. An account that left joins again last, from now on, with
   * the time of this join. Records MemberJoined.
   */
  join(accountId: Id, at: Date): IResult {
    const open = this.mayChange();
    if (open.isFailure()) return open;
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
   * A member leaves the group, whatever its balance (request 20). The owner never does, and a non-member cannot. The
   * balance and whether a payment of the member waits at the provider are read by the caller and given as plain values:
   * a member with a payment waiting cannot leave until it has ended. The balance passes to the owner in the same step:
   * records BalancePassed (from the member, to the owner, the balance), then MemberLeft.
   */
  leave({
    accountId,
    balance,
    paymentWaiting,
    at,
  }: {
    accountId: Id;
    balance: number;
    paymentWaiting: boolean;
    at: Date;
  }): IResult {
    const open = this.mayChange();
    if (open.isFailure()) return open;
    if (accountId.equals(this.ownerId)) return Result.fail(new OwnerCannotLeave());
    if (!this.hasMember(accountId)) return Result.fail(new NotAMember());
    if (paymentWaiting) return Result.fail(new PaymentWaitingAtProvider());
    this._memberships = this._memberships.map(membership =>
      membership.accountId.equals(accountId) ? { ...membership, leftAt: at } : membership,
    );
    this._passed = [
      ...this._passed,
      { fromId: accountId, toId: this.ownerId, amount: balance, passedAt: at, origin: null },
    ];
    this.record(
      BalancePassedEvent.set({
        groupId: this._id.value,
        fromId: accountId.value,
        toId: this.ownerId.value,
        amount: balance,
        passedAt: at.toISOString(),
      }),
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
      snapshot.passed.map(passed => ({
        fromId: new Id(passed.fromId),
        toId: new Id(passed.toId),
        amount: passed.amount,
        passedAt: new Date(passed.passedAt),
        origin: passed.origin ?? null,
      })),
      createdAt,
      snapshot.archivedAt ? new Date(snapshot.archivedAt) : null,
      snapshot.mergedInto ? new Id(snapshot.mergedInto) : null,
    );
  }

  /** The archiving moment, null while the group is not archived. */
  get archivedAt(): Date | null {
    return this._archivedAt;
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

  /** The balances that passed to the owner when members left, the earliest first. */
  get passed(): readonly PassedBalance[] {
    return this._passed;
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
      passed: this._passed.map((passed): PassedBalanceSnapshot => ({
        fromId: passed.fromId.value,
        toId: passed.toId.value,
        amount: passed.amount,
        passedAt: passed.passedAt.toISOString(),
        origin: passed.origin,
      })),
      createdAt: this.createdAt.toISOString(),
      archivedAt: this._archivedAt === null ? null : this._archivedAt.toISOString(),
      mergedInto: this._mergedInto === null ? null : this._mergedInto.value,
      version: this.version,
    };
  }
}
