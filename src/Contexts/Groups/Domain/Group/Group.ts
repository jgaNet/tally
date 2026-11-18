import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { GroupArchived } from '@SharedKernel/Domain';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import { GroupSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';
import {
  AlreadyMember,
  GroupNotSettled,
  NotAMember,
  OnlyTheOwnerArchives,
  OwnerCannotLeave,
  PaymentWaitingAtProvider,
} from '@Contexts/Groups/Domain/Group/GroupExceptions';
import {
  BalancePassedEvent,
  GroupArchivedEvent,
  GroupCreatedEvent,
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
    this._passed = [...this._passed, { fromId: accountId, toId: this.ownerId, amount: balance, passedAt: at }];
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
      })),
      createdAt,
      snapshot.archivedAt ? new Date(snapshot.archivedAt) : null,
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
      })),
      createdAt: this.createdAt.toISOString(),
      archivedAt: this._archivedAt === null ? null : this._archivedAt.toISOString(),
      version: this.version,
    };
  }
}
