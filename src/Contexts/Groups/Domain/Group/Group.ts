import { AggregateRoot, DomainEvent, Id, IResult, Result } from '@Architecture/Domain';
import { GroupArchivedException } from '@SharedKernel/Domain';

import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import {
  AlreadyMemberException,
  GroupNotFoundException,
  GroupNotSettledException,
  OnlyTheOwnerArchivesException,
  OwnerCannotLeaveException,
  PaymentWaitingException,
} from '@Contexts/Groups/Domain/Group/GroupExceptions';

/**
 * A group, as the domain keeps it: people who share expenses in one currency, fixed when it is created, owned by the
 * account that created it, whose members are kept in the order they joined, the owner first (conventions/domain.yaml,
 * ADR 5, feature 3). It is an aggregate root because the Lite trigger for it is taken by ADR 5; nothing else in the
 * aggregate changes its currency.
 *
 * A member who leaves (feature 9, request 20) is no longer among `members`, and is kept in `formerMembers` with when they
 * left. What they owed or were owed passed to the owner when they left (`passes`, ADR 15): a pass is kept for good, so the
 * balances still add up to 0 and a member who joins again starts at 0.
 *
 * An archived group (feature 27, request 27) is read only: once `archivedAt` is set nothing in it changes. Every change a
 * member asks for is refused by the shared kernel's GroupArchived (`openForChanges`), and the group is never unarchived.
 */
export class Group extends AggregateRoot {
  readonly #name: GroupName;
  readonly #currency: Currency;
  readonly #ownerId: string;
  readonly #members: GroupMember[];
  readonly #formerMembers: FormerMember[];
  readonly #passes: BalancePass[];
  readonly #createdAt: string;
  #archivedAt: string | undefined;

  private constructor(
    id: Id,
    name: GroupName,
    currency: Currency,
    ownerId: string,
    members: GroupMember[],
    formerMembers: FormerMember[],
    passes: BalancePass[],
    createdAt: string,
    archivedAt: string | undefined,
    version: number,
  ) {
    super(id, version);
    this.#name = name;
    this.#currency = currency;
    this.#ownerId = ownerId;
    this.#members = members;
    this.#formerMembers = formerMembers;
    this.#passes = passes;
    this.#createdAt = createdAt;
    this.#archivedAt = archivedAt;
  }

  /** The account that created the group. */
  get ownerId(): string {
    return this.#ownerId;
  }

  /** When the group was archived, or `undefined` while it is not (feature 27). */
  get archivedAt(): string | undefined {
    return this.#archivedAt;
  }

  /**
   * Whether a change in the group may be made: refused with GroupArchived once it is archived (feature 27, request 27). Every change
   * of the group's members or invitations asks it first; the refusal changes nothing.
   */
  openForChanges(): IResult<void> {
    return this.#archivedAt === undefined ? Result.ok(undefined) : Result.fail(new GroupArchivedException());
  }

  /** The members in the order they joined, the owner first. A copy: the aggregate keeps its own list. */
  members(): GroupMember[] {
    return this.#members.map(member => ({ ...member }));
  }

  /** The members who have left, with when each joined and when it left. A copy: the aggregate keeps its own list. */
  formerMembers(): FormerMember[] {
    return this.#formerMembers.map(member => ({ ...member }));
  }

  /** The balances that passed to the owner when members left, in the order they were made. A copy. */
  passes(): BalancePass[] {
    return this.#passes.map(pass => ({ ...pass }));
  }

  /** Whether the account is one of the group's members now. */
  hasMember(accountId: string): boolean {
    return this.#members.some(member => member.accountId === accountId);
  }

  /**
   * A creation: the name and the currency must be ones the domain allows, the owner is the account that asks and is the
   * group's first member. The identity is generated here (DOMAIN-IDENTITY), and the creation records GroupCreated. Pure:
   * the time is `now`. Named `register`, as the contract allows for a creation (ADR 5): the inventory matches a behaviour
   * by its name in any call, so two aggregates' `create` would be taken for one another.
   */
  static register({ name, currency, ownerId }: GroupDraft, now: Date): IResult<Group> {
    const groupName = GroupName.create(name);
    if (groupName.isFailure()) return Result.fail(groupName.error);

    const groupCurrency = Currency.create(currency);
    if (groupCurrency.isFailure()) return Result.fail(groupCurrency.error);

    const id = Id.generate();
    const at = now.toISOString();
    const group = new Group(
      id,
      groupName.data,
      groupCurrency.data,
      ownerId,
      [{ accountId: ownerId, joinedAt: at }],
      [],
      [],
      at,
      undefined,
      0,
    );
    group.record(GroupCreatedEvent.set({ groupId: id.value, createdBy: ownerId, at }));
    return Result.ok(group);
  }

  /**
   * An account joins the group (feature 3): once only, and it becomes the last of the members. Refused with
   * `AlreadyMember` when it is one already. An account that left before (feature 9) is a member again from now: it leaves
   * its former row and joins last, with the balance its earlier expenses gave it. Records MemberJoined; the time is `now`.
   */
  join(accountId: string, now: Date): IResult<void> {
    const open = this.openForChanges();
    if (open.isFailure()) return open;
    if (this.hasMember(accountId)) return Result.fail(new AlreadyMemberException());

    const at = now.toISOString();
    const index = this.#formerMembers.findIndex(member => member.accountId === accountId);
    if (index >= 0) this.#formerMembers.splice(index, 1);
    this.#members.push({ accountId, joinedAt: at });
    this.record(MemberJoinedEvent.set({ groupId: this._id.value, accountId, at }));
    return Result.ok(undefined);
  }

  /**
   * A member leaves the group (feature 9, request 20): whatever their balance in it, which the caller reads from Ledger
   * and gives here as a plain value, together with whether a payment of theirs waits at the provider. The owner never
   * leaves (`403`); a member who is not one of the group is not there for them (`404`); a member with a payment waiting
   * (pending or refunding) waits for it to end (`PaymentWaiting`, `422`). Otherwise the balance passes to the owner, in the
   * same step: BalancePassed, then MemberLeft are recorded, and the time is `now`. Pure.
   */
  leave(accountId: string, reading: LeaveReading, now: Date): IResult<void> {
    const open = this.openForChanges();
    if (open.isFailure()) return open;
    if (accountId === this.#ownerId) return Result.fail(new OwnerCannotLeaveException());

    const member = this.#members.find(candidate => candidate.accountId === accountId);
    if (!member) return Result.fail(new GroupNotFoundException());
    if (reading.paymentWaiting) return Result.fail(new PaymentWaitingException());

    const at = now.toISOString();
    const pass: BalancePass = { fromAccountId: accountId, toAccountId: this.#ownerId, amount: reading.balance, at };
    this.#passes.push(pass);
    this.record(
      BalancePassedEvent.set({
        groupId: this._id.value,
        fromAccountId: pass.fromAccountId,
        toAccountId: pass.toAccountId,
        amount: pass.amount,
        at,
      }),
    );
    this.#members.splice(this.#members.indexOf(member), 1);
    this.#formerMembers.push({ accountId, joinedAt: member.joinedAt, leftAt: at });
    this.record(MemberLeftEvent.set({ groupId: this._id.value, accountId, at }));
    return Result.ok(undefined);
  }

  /**
   * The group is archived (feature 27, request 27): by its owner, once every member's balance is 0 and no payment through the provider is
   * pending or refunding (the reading the caller takes, as a plain value). Refused with GroupArchived when it is archived already (`422`),
   * with `403` to any member who is not its owner, and with GroupNotSettled (`422`) while a balance is not 0 or a payment waits. Records
   * GroupArchived, and the time is `now`. Pure. An archived group stays archived.
   */
  archive(accountId: string, reading: ArchiveReading, now: Date): IResult<void> {
    const open = this.openForChanges();
    if (open.isFailure()) return open;
    if (accountId !== this.#ownerId) return Result.fail(new OnlyTheOwnerArchivesException());
    if (!reading.balancesCleared || reading.paymentWaiting) return Result.fail(new GroupNotSettledException());

    const at = now.toISOString();
    this.#archivedAt = at;
    this.record(GroupArchivedEvent.set({ groupId: this._id.value, at }));
    return Result.ok(undefined);
  }

  /** The group as the store keeps it. Records nothing; throws on a snapshot that is not a group the domain accepts. */
  static fromSnapshot(snapshot: GroupSnapshot): Group {
    const name = GroupName.create(snapshot.name);
    const currency = Currency.create(snapshot.currency);
    if (name.isFailure() || currency.isFailure() || snapshot.members[0]?.accountId !== snapshot.ownerId) {
      throw new Error(`The group ${snapshot.id} is corrupted: its name, currency or first member is not the domain's`);
    }
    return new Group(
      new Id(snapshot.id),
      name.data,
      currency.data,
      snapshot.ownerId,
      snapshot.members.map(member => ({ ...member })),
      snapshot.formerMembers.map(member => ({ ...member })),
      snapshot.passes.map(pass => ({ ...pass })),
      snapshot.createdAt,
      snapshot.archivedAt,
      snapshot.version,
    );
  }

  toSnapshot(): GroupSnapshot {
    return {
      id: this._id.value,
      name: this.#name.value,
      currency: this.#currency.value,
      ownerId: this.#ownerId,
      members: this.members(),
      formerMembers: this.formerMembers(),
      passes: this.passes(),
      createdAt: this.#createdAt,
      archivedAt: this.#archivedAt,
      version: this.version,
    };
  }
}

/**
 * What an archive is decided on, read by the caller (feature 27): whether every member's balance in the group is 0, and whether a payment
 * through the provider is pending or refunding in it.
 */
export interface ArchiveReading {
  readonly balancesCleared: boolean;
  readonly paymentWaiting: boolean;
}

/** What a leave is decided on, read by the caller: the member's balance in the group, and whether a payment of theirs waits. */
export interface LeaveReading {
  /** The member's balance in the group, in the group's currency's hundredths: what passes to the owner. */
  readonly balance: number;
  /** Whether a payment the member pays or receives through the provider is pending or refunding. */
  readonly paymentWaiting: boolean;
}

/** What passed to the owner when a member left: the leaver, the owner it passed to, the amount, and when (ADR 15). */
export interface BalancePass {
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly amount: number;
  readonly at: string;
}

/** What a creation gives the aggregate: the typed values, and the account that creates the group. */
export interface GroupDraft {
  readonly name: string;
  readonly currency: string;
  readonly ownerId: string;
}

/** A member of a group: the account, and when it joined (the owner, when the group was created). */
export interface GroupMember {
  readonly accountId: string;
  readonly joinedAt: string;
}

/** A member who has left a group: the account, when it joined, and when it left (feature 9). */
export interface FormerMember extends GroupMember {
  readonly leftAt: string;
}

/**
 * A group as the store keeps it, its version included. `members` starts with the owner, in the order they joined, and holds
 * the members now; `formerMembers` holds those who have left.
 */
export interface GroupSnapshot {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly ownerId: string;
  readonly members: readonly GroupMember[];
  readonly formerMembers: readonly FormerMember[];
  /** The balances that passed to the owner when members left, in the order they were made (request 20). */
  readonly passes: readonly BalancePass[];
  readonly createdAt: string;
  /** When the group was archived (feature 27); absent while it is not. */
  readonly archivedAt?: string;
  readonly version: number;
}

export type GroupCreatedPayload = { groupId: string; createdBy: string; at: string };

/**
 * The fact of a creation (ADR 5): who created the group, and when. It is made durable with the group and published after
 * the commit; nothing subscribes to it yet.
 */
export class GroupCreatedEvent extends DomainEvent<GroupCreatedPayload> {}

export type MemberJoinedPayload = { groupId: string; accountId: string; at: string };

/**
 * The fact of a join (feature 3): which account joined which group, and when. It is made durable with the group and
 * published after the commit; nothing subscribes to it (no integration event, T3 in ADR 1).
 */
export class MemberJoinedEvent extends DomainEvent<MemberJoinedPayload> {}

export type MemberLeftPayload = { groupId: string; accountId: string; at: string };

/**
 * The fact of a leave (feature 9): which account left which group, and when. It is made durable with the group and published
 * after the commit; nothing subscribes to it (Ledger reads the members when it decides, as for joining).
 */
export class MemberLeftEvent extends DomainEvent<MemberLeftPayload> {}

export type GroupArchivedPayload = { groupId: string; at: string };

/**
 * The fact of an archive (feature 27): which group was archived, and when. It is made durable with the group and published after the
 * commit; nothing subscribes to it yet (the other contexts ask Groups through their own ports, not by this event).
 */
export class GroupArchivedEvent extends DomainEvent<GroupArchivedPayload> {}

export type BalancePassedPayload = {
  groupId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  at: string;
};

/**
 * The fact of a balance passing (request 20): the balance a leaving member had passed to the owner, in the same step as the leave.
 * It is made durable with the group and published after the commit; nothing subscribes to it.
 */
export class BalancePassedEvent extends DomainEvent<BalancePassedPayload> {}
