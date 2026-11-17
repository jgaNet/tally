import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import { GroupSnapshot } from '@Contexts/Groups/Domain/Group/DTOs';
import {
  BalancePassedEvent,
  GroupCreatedEvent,
  MemberJoinedEvent,
  MemberLeftEvent,
} from '@Contexts/Groups/Domain/Group/Events/GroupEvents';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import {
  AlreadyAMember,
  NotAMember,
  OwnerCannotLeave,
  PaymentWaitingAtProvider,
} from '@Contexts/Groups/Domain/Group/GroupExceptions';

/** One member of a group: an account, from the moment it joined. */
export interface Membership {
  accountId: Id;
  joinedAt: Date;
}

/** A member who left: the membership it had, and when it left (ADR 4). */
export interface Departure extends Membership {
  leftAt: Date;
}

/** A balance passed to the owner when a member left (request 20): the leaver's balance, from the leaver to the owner. */
export interface Passage {
  from: Id;
  to: Id;
  amount: number;
}

/**
 * A group of people who share expenses, in one currency fixed when it is created and never changed. Its owner is its
 * first member; whoever joins later joins by an invitation, and may leave whatever their balance (the owner never does):
 * the balance passes to the owner in the same step. A member who left is kept apart in `departed`: the expenses they were
 * in still say who they were, and joining again makes them a member once more.
 */
export class Group extends AggregateRoot {
  private constructor(
    id: Id,
    readonly name: GroupName,
    readonly currency: Currency,
    readonly ownerId: Id,
    /** The members in the order they joined; the owner is the first. */
    readonly members: Membership[],
    /** The members who left, kept as they were: none of them is in `members`. */
    readonly departed: Departure[],
    /** The balances passed to the owner when members left, in the order they passed. */
    readonly passages: Passage[],
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
    const group = new Group(
      Id.generate(),
      name,
      currency,
      ownerId,
      [{ accountId: ownerId, joinedAt: now }],
      [],
      [],
      now,
      0,
    );
    group.record(GroupCreatedEvent.set({ groupId: group._id.value, ownerId: ownerId.value }));
    return group;
  }

  static fromSnapshot(snapshot: GroupSnapshot): Group {
    const name = GroupName.create(snapshot.name);
    const currency = Currency.create(snapshot.currency);
    const createdAt = new Date(snapshot.createdAt);
    const joinedAt = snapshot.members.map(member => new Date(member.joinedAt));
    const leftAt = snapshot.departed.map(member => new Date(member.leftAt));
    const current = new Set(snapshot.members.map(member => member.accountId));
    if (
      name.isFailure() ||
      currency.isFailure() ||
      Number.isNaN(createdAt.getTime()) ||
      !snapshot.members.length ||
      snapshot.members[0].accountId !== snapshot.ownerId ||
      joinedAt.some(date => Number.isNaN(date.getTime())) ||
      leftAt.some(date => Number.isNaN(date.getTime())) ||
      snapshot.departed.some(member => current.has(member.accountId) || member.accountId === snapshot.ownerId)
    ) {
      throw new Error(`The group ${snapshot.id} is corrupted`);
    }
    return new Group(
      new Id(snapshot.id),
      name.data,
      currency.data,
      new Id(snapshot.ownerId),
      snapshot.members.map((member, index) => ({ accountId: new Id(member.accountId), joinedAt: joinedAt[index] })),
      snapshot.departed.map((member, index) => ({
        accountId: new Id(member.accountId),
        joinedAt: new Date(member.joinedAt),
        leftAt: leftAt[index],
      })),
      snapshot.passages.map(passage => ({
        from: new Id(passage.from),
        to: new Id(passage.to),
        amount: passage.amount,
      })),
      createdAt,
      snapshot.version,
    );
  }

  /** Whether this account is one of the group's current members: the owner, or whoever joined and has not left. */
  isMember(accountId: Id): boolean {
    return this.members.some(member => member.accountId.value === accountId.value);
  }

  /** Whether this account has been a member of the group, now or before it left. */
  hasBeenMember(accountId: Id): boolean {
    return this.isMember(accountId) || this.departed.some(member => member.accountId.value === accountId.value);
  }

  /**
   * The account joins the group as its newest member, at `now`, the application's clock. Refused when it is a member
   * already. A former member joins again the same way: it is taken out of the departed and joins last.
   */
  join({ accountId, now }: { accountId: Id; now: Date }): IResult {
    if (this.isMember(accountId)) return Result.fail(new AlreadyAMember());
    const index = this.departed.findIndex(member => member.accountId.value === accountId.value);
    if (index >= 0) this.departed.splice(index, 1);
    this.members.push({ accountId, joinedAt: now });
    this.record(MemberJoinedEvent.set({ groupId: this._id.value, accountId: accountId.value }));
    return Result.ok();
  }

  /**
   * The member leaves the group, at `now`, whatever their balance: `balance` is the member's balance in the group, read by the
   * handler from Ledger, and it passes to the owner in the same step (a `BalancePassed` recorded beside `MemberLeft`). The leave
   * is refused while `paymentWaiting` says a payment they pay or receive is waiting at the provider, and the owner never leaves.
   * The member is kept as a former one, with the time it left. For anyone who is not a member the group does not exist; the
   * handler answers that before it reads the balance.
   */
  leave({
    accountId,
    balance,
    paymentWaiting,
    now,
  }: {
    accountId: Id;
    balance: number;
    paymentWaiting: boolean;
    now: Date;
  }): IResult {
    if (!this.isMember(accountId)) return Result.fail(new NotAMember());
    if (accountId.value === this.ownerId.value) return Result.fail(new OwnerCannotLeave());
    if (paymentWaiting) return Result.fail(new PaymentWaitingAtProvider());

    const index = this.members.findIndex(member => member.accountId.value === accountId.value);
    const [member] = this.members.splice(index, 1);
    this.departed.push({ accountId: member.accountId, joinedAt: member.joinedAt, leftAt: now });
    this.passages.push({ from: accountId, to: this.ownerId, amount: balance });
    this.record(
      BalancePassedEvent.set({
        groupId: this._id.value,
        fromAccountId: accountId.value,
        toAccountId: this.ownerId.value,
        amount: balance,
      }),
    );
    this.record(MemberLeftEvent.set({ groupId: this._id.value, accountId: accountId.value }));
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
      departed: this.departed.map(member => ({
        accountId: member.accountId.value,
        joinedAt: member.joinedAt.toISOString(),
        leftAt: member.leftAt.toISOString(),
      })),
      passages: this.passages.map(passage => ({
        from: passage.from.value,
        to: passage.to.value,
        amount: passage.amount,
      })),
      createdAt: this.createdAt.toISOString(),
      version: this.version,
    };
  }
}
