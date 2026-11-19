import { AggregateRoot, Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { CurrencyCode, GroupArchivedException } from '@SharedKernel/Domain';

import { Currency } from './Currency';
import {
  BalancePassedEvent,
  GroupArchivedEvent,
  GroupCreatedEvent,
  GroupsMergedEvent,
  MemberJoinedEvent,
  MemberLeftEvent,
} from './GroupEvents';
import { AlreadyMemberException, OwnerCannotLeaveException } from './GroupExceptions';
import { GroupName } from './GroupName';

/** A member as it is stored: the account, and when it joined. */
export interface GroupMemberSnapshot {
  accountId: string;
  joinedAt: string;
}

/** A group as it is stored: its name, its currency, its owner, when it was created, and its members in the order they joined. */
export interface GroupSnapshot {
  id: string;
  name: string;
  currency: CurrencyCode;
  ownerId: string;
  createdAt: string;
  members: GroupMemberSnapshot[];
  version: number;
  /** When the owner archived it, once it is archived (request 27); absent before. */
  archivedAt?: string;
  /** The group kept, once this group was merged into it (request 31): the group is gone, and nothing is stored under it but this. */
  mergedInto?: string;
}

/** A balance that passed from a member who left to the owner, when it left (request 20): what the member's balance was, and the owner. */
export interface GroupPass {
  from: string;
  to: string;
  amount: number;
  at: Date;
}

/** A member of a group: the account, and when it joined. The owner is the first, joined when the group was created. */
export interface GroupMember {
  readonly accountId: string;
  readonly joinedAt: Date;
}

/**
 * People who share expenses in one currency, fixed when it is created, owned by the account that created it (ADR 3).
 * Its id is born here, once; its rules are the decision's (`Group.decision.ts`), which checks what it is given before
 * it is made. It holds its members in the order they joined and keeps each account a member once (ADR 4). It carries
 * the version it was loaded at, and its repository refuses to save it over a newer one (CONC-OPTIMISTIC).
 */
export class Group extends AggregateRoot {
  readonly #name: GroupName;
  readonly #currency: Currency;
  readonly #ownerId: string;
  readonly #createdAt: Date;
  readonly #members: GroupMember[];
  readonly #passes: GroupPass[] = [];
  #archivedAt: Date | undefined;
  #mergedInto: string | undefined;

  private constructor(
    id: Id,
    version: number,
    name: GroupName,
    currency: Currency,
    ownerId: string,
    createdAt: Date,
    members: GroupMember[],
    archivedAt: Date | undefined,
  ) {
    super(id, version);
    this.#name = name;
    this.#currency = currency;
    this.#ownerId = ownerId;
    this.#createdAt = createdAt;
    this.#members = members;
    this.#archivedAt = archivedAt;
  }

  /** A new group, with its id generated here, its owner as its first member, recording that it was registered at `at`. */
  static register({
    name,
    currency,
    ownerId,
    at,
  }: {
    name: GroupName;
    currency: Currency;
    ownerId: string;
    at: Date;
  }): Group {
    const group = new Group(
      Id.generate(),
      0,
      name,
      currency,
      ownerId,
      at,
      [{ accountId: ownerId, joinedAt: at }],
      undefined,
    );
    group.record(GroupCreatedEvent.set({ groupId: group._id.value, ownerId, createdAt: at }));
    return group;
  }

  /**
   * Rebuilds a group as it was stored, at the version it was stored at. Records nothing, and throws on data no
   * `register()` or `join()` could have made: the owner is a member, first, and the members are all distinct.
   */
  static fromSnapshot(snapshot: GroupSnapshot): Group {
    const name = GroupName.create(snapshot.name);
    const currency = Currency.create(snapshot.currency);
    const createdAt = new Date(snapshot.createdAt);
    const members = snapshot.members.map(member => ({
      accountId: member.accountId,
      joinedAt: new Date(member.joinedAt),
    }));
    const archivedAt = snapshot.archivedAt === undefined ? undefined : new Date(snapshot.archivedAt);
    const corrupted =
      name.isFailure() ||
      currency.isFailure() ||
      Number.isNaN(createdAt.getTime()) ||
      members[0]?.accountId !== snapshot.ownerId ||
      members.some(member => Number.isNaN(member.joinedAt.getTime())) ||
      new Set(members.map(member => member.accountId)).size !== members.length ||
      (archivedAt !== undefined && Number.isNaN(archivedAt.getTime()));
    if (corrupted) throw new Error(`The stored group ${snapshot.id} is corrupted`);
    return new Group(
      new Id(snapshot.id),
      snapshot.version,
      name.data!,
      currency.data!,
      snapshot.ownerId,
      createdAt,
      members,
      archivedAt,
    );
  }

  /**
   * The owner archives the group at `at` (request 27): nothing in it changes after. Recorded as `GroupArchived` and published after its
   * save. Refused when it is archived already. Whether the archive may be is the decision's to say (`decideArchiveGroup`), before this is called.
   */
  archive(at: Date): IResult<void> {
    if (this.#archivedAt !== undefined) return Result.fail(new GroupArchivedException());
    this.#archivedAt = at;
    this.record(GroupArchivedEvent.set({ groupId: this._id.value, archivedAt: at }));
    return Result.ok(undefined);
  }

  /**
   * The group kept takes the members of `merged` at `at` (request 31): each one not among its members yet joins it, as its last member, in
   * the order they joined the group merged; a member of both stays where it is. Recorded as `GroupsMerged` (the group merged is named by
   * its id). Refused when this group is archived; whether the merge may be is the decision's to say (`decideMergeGroups`), before this is called.
   */
  absorb(merged: Group, at: Date): IResult<void> {
    if (this.#archivedAt !== undefined) return Result.fail(new GroupArchivedException());
    for (const member of merged.members) {
      if (!this.hasMember(member.accountId)) this.#members.push({ accountId: member.accountId, joinedAt: at });
    }
    this.record(GroupsMergedEvent.set({ groupId: this._id.value, mergedGroupId: merged._id.value, at }));
    return Result.ok(undefined);
  }

  /**
   * The group merged is closed into the group kept `keptId` (request 31): it has no members any more, so it is no group for anyone, and
   * it is stored as merged into `keptId` in the same write as its members' removal. Its members are the group kept's, taken by `absorb`.
   */
  closeInto(keptId: string): IResult<void> {
    if (this.#archivedAt !== undefined) return Result.fail(new GroupArchivedException());
    this.#mergedInto = keptId;
    this.#members.splice(0, this.#members.length);
    return Result.ok(undefined);
  }

  /**
   * An account joins the group at `at`, as the last member. Refused when it is a member already; recorded as
   * `MemberJoined` otherwise.
   */
  join(accountId: string, at: Date): IResult<void> {
    if (this.#archivedAt !== undefined) return Result.fail(new GroupArchivedException());
    if (this.hasMember(accountId)) return Result.fail(new AlreadyMemberException());
    this.#members.push({ accountId, joinedAt: at });
    this.record(MemberJoinedEvent.set({ groupId: this._id.value, accountId, joinedAt: at }));
    return Result.ok(undefined);
  }

  /**
   * A member leaves the group at `at`, its balance of `balancePassed` passing to the owner in the same step (request 20): it is no
   * longer among its members, and the group is not among its groups. Recorded as `MemberLeft` and `BalancePassed`. Refused for the
   * owner, who stays, and for an account that is not a member; whether the leaving may be is the decision's to say
   * (`decideLeaveGroup`), before this is called.
   */
  leave(accountId: string, at: Date, balancePassed: number): IResult<void> {
    if (this.#archivedAt !== undefined) return Result.fail(new GroupArchivedException());
    if (accountId === this.#ownerId) return Result.fail(new OwnerCannotLeaveException());
    const index = this.#members.findIndex(member => member.accountId === accountId);
    if (index === -1) return Result.fail(new NotFoundException('Groups', 'No group is found'));
    this.#members.splice(index, 1);
    this.#passes.push({ from: accountId, to: this.#ownerId, amount: balancePassed, at });
    this.record(MemberLeftEvent.set({ groupId: this._id.value, accountId, leftAt: at }));
    this.record(
      BalancePassedEvent.set({
        groupId: this._id.value,
        from: accountId,
        to: this.#ownerId,
        amount: balancePassed,
        at,
      }),
    );
    return Result.ok(undefined);
  }

  /** The balances that passed to the owner by leaving, made since the group was read: what the repository stores with the group. */
  get newPasses(): readonly GroupPass[] {
    return [...this.#passes];
  }

  hasMember(accountId: string): boolean {
    return this.#members.some(member => member.accountId === accountId);
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

  get createdAt(): Date {
    return this.#createdAt;
  }

  /** When the group was archived, `undefined` while it is not (request 27). */
  get archivedAt(): Date | undefined {
    return this.#archivedAt;
  }

  /** The group kept, once this group was merged into it (request 31); `undefined` while it is not merged. */
  get mergedInto(): string | undefined {
    return this.#mergedInto;
  }

  /** The members, in the order they joined: the owner first. */
  get members(): readonly GroupMember[] {
    return [...this.#members];
  }

  toSnapshot(): GroupSnapshot {
    return {
      id: this._id.value,
      name: this.#name.value,
      currency: this.#currency.value,
      ownerId: this.#ownerId,
      createdAt: this.#createdAt.toISOString(),
      members: this.#members.map(member => ({
        accountId: member.accountId,
        joinedAt: member.joinedAt.toISOString(),
      })),
      version: this.version,
      ...(this.#archivedAt === undefined ? {} : { archivedAt: this.#archivedAt.toISOString() }),
      ...(this.#mergedInto === undefined ? {} : { mergedInto: this.#mergedInto }),
    };
  }
}
