import { AggregateRoot, IResult, Id, NotFoundException, Result } from '@Architecture/Domain';

import { IGroupSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import {
  AlreadyMemberException,
  OwnerCannotLeaveException,
  PaymentWaitingException,
} from '@Contexts/Groups/Domain/Group/GroupExceptions';
import {
  BalancePassedEvent,
  GroupCreatedEvent,
  MemberJoinedEvent,
  MemberLeftEvent,
} from '@Contexts/Groups/Domain/Group/Events/GroupEvents';

/** A member of a group: the account, and when it joined. */
export interface GroupMember {
  accountId: string;
  joinedAt: Date;
}

/** A balance passed on when a member left: the amount, from the member who left to the one who takes it over (the owner). */
export interface BalancePassing {
  from: string;
  to: string;
  amount: number;
}

/**
 * Group is the aggregate root of Groups' groups: the people who share expenses in one currency, fixed when the
 * group is created (the storm's decision). Its creator is its owner and its first member. Other accounts join by an
 * invitation (request 3), and each account is a member once: the group keeps that, since it is the one place the
 * membership lives.
 *
 * A member leaves whatever their balance (request 20): what it is passes to the owner in the same step, and is kept as
 * a passing, so that the balances of the members still add up to 0. The owner never leaves, and a member whose
 * payment waits at the provider does not leave until it has ended. A member who left is kept among the former
 * members, so that the group still knows every account that has been one (a former member's statement is read by the
 * group's members); a member who joins again is taken out of them and put last among the members, from the moment
 * they join.
 *
 * The name and the currency are value objects, validated by their own `create()`, so a group once held is valid.
 * The name is the only thing that changes after the creation, and no behaviour here changes it; the behaviours are
 * the creation, which records GroupCreated, a join, which records MemberJoined, and a leave, which records
 * BalancePassed and MemberLeft.
 */
export class Group extends AggregateRoot {
  readonly #name: GroupName;
  readonly #currency: Currency;
  readonly #ownerId: string;
  readonly #members: GroupMember[];
  readonly #formerMembers: GroupMember[];
  readonly #passings: BalancePassing[];
  readonly #createdAt: Date;

  private constructor(
    id: Id,
    name: GroupName,
    currency: Currency,
    ownerId: string,
    members: GroupMember[],
    formerMembers: GroupMember[],
    passings: BalancePassing[],
    createdAt: Date,
    version: number,
  ) {
    super(id, version);
    this.#name = name;
    this.#currency = currency;
    this.#ownerId = ownerId;
    this.#members = members;
    this.#formerMembers = formerMembers;
    this.#passings = passings;
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
      [],
      [],
      createdAt,
      0,
    );
    group.record(GroupCreatedEvent.set({ groupId: group._id.value, ownerId }));
    return Result.ok(group);
  }

  /**
   * An account joins the group: it becomes its last member, at the time given, and MemberJoined is recorded. Refused
   * with AlreadyMember when the account is one of its members already; a member is never added twice. An account
   * that left is taken out of the former members, so that it is a member once more.
   */
  join({ accountId, joinedAt }: { accountId: string; joinedAt: Date }): IResult<void> {
    if (this.isMember(accountId)) return Result.fail(new AlreadyMemberException());

    const former = this.#formerMembers.findIndex(member => member.accountId === accountId);
    if (former >= 0) this.#formerMembers.splice(former, 1);
    this.#members.push({ accountId, joinedAt });
    this.record(MemberJoinedEvent.set({ groupId: this._id.value, accountId }));
    return Result.ok();
  }

  /**
   * A member leaves the group, whatever its balance (request 20). The group refuses the owner always, and a member
   * with a payment waiting at the provider, which the caller read through its port. Otherwise the member's balance,
   * as the Ledger counts it, passes to the owner: it is kept as a passing, and BalancePassed is recorded before
   * MemberLeft, in the same step. The account is no longer among the members, and is kept among the former ones. An
   * account that is not a member is not in the group, so it is refused as a group that does not exist. The balance and
   * the waiting payment are plain values the caller read from the other contexts through its ports.
   */
  leave({
    accountId,
    balance,
    paymentWaiting,
  }: {
    accountId: string;
    balance: number;
    paymentWaiting: boolean;
  }): IResult<void> {
    const index = this.#members.findIndex(member => member.accountId === accountId);
    if (index < 0) return Result.fail(new NotFoundException('Groups', 'Group not found'));
    if (accountId === this.#ownerId) return Result.fail(new OwnerCannotLeaveException());
    if (paymentWaiting) return Result.fail(new PaymentWaitingException());

    const [left] = this.#members.splice(index, 1);
    this.#formerMembers.push(left);
    this.#passings.push({ from: accountId, to: this.#ownerId, amount: balance });
    this.record(
      BalancePassedEvent.set({ groupId: this._id.value, from: accountId, to: this.#ownerId, amount: balance }),
    );
    this.record(MemberLeftEvent.set({ groupId: this._id.value, accountId }));
    return Result.ok();
  }

  /** Whether this account is one of the group's current members. */
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
    const formerMembers = snapshot.formerMembers.map(member => ({
      accountId: member.accountId,
      joinedAt: new Date(member.joinedAt),
    }));
    const passings = snapshot.passings.map(passing => ({ ...passing }));
    const accounts = [...members, ...formerMembers].map(member => member.accountId);
    if (
      name.isFailure() ||
      currency.isFailure() ||
      !members.some(member => member.accountId === snapshot.ownerId) ||
      new Set(accounts).size !== accounts.length ||
      [...members, ...formerMembers].some(member => Number.isNaN(member.joinedAt.getTime())) ||
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
      formerMembers,
      passings,
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
      formerMembers: this.#formerMembers.map(member => ({
        accountId: member.accountId,
        joinedAt: member.joinedAt.toISOString(),
      })),
      passings: this.#passings.map(passing => ({ ...passing })),
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

  /** The current members in the order they joined: the owner first. */
  get members(): readonly GroupMember[] {
    return this.#members;
  }

  /** The accounts that were members and left, in the order they left. */
  get formerMembers(): readonly GroupMember[] {
    return this.#formerMembers;
  }

  /** The balances passed on when members left, in the order they were passed (request 20). */
  get passings(): readonly BalancePassing[] {
    return this.#passings;
  }

  get createdAt(): Date {
    return this.#createdAt;
  }
}
