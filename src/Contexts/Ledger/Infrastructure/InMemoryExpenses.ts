import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';

import { IBalanceCounts } from '@Contexts/Ledger/Application/Ports/IBalanceCounts';
import { IBalanceQueries } from '@Contexts/Ledger/Application/Ports/IBalanceQueries';
import { MemberBalanceReadModel } from '@Contexts/Ledger/Application/ReadModel/MemberBalanceReadModel';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { ExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { GroupRole, IGroupMembers, PassedBalance } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/** The expenses kept in a Map: the double the unit tests use for the repository. */
export type InMemoryExpenseStore = Map<string, ExpenseSnapshot>;

/** Stores like the SQLite repository: a new expense at version 1, a changed one at its version + 1, a conflict otherwise. */
export class InMemoryExpenseRepository implements IExpenseRepository {
  constructor(private store: InMemoryExpenseStore) {}

  async findById(id: Id): Promise<Expense | null> {
    const snapshot = this.store.get(id.value);
    return snapshot ? Expense.fromSnapshot(snapshot) : null;
  }

  async save(expense: Expense): Promise<IResult> {
    const snapshot = expense.toSnapshot();
    if (snapshot.version === 0) {
      this.store.set(snapshot.id, { ...snapshot, version: 1 });
      return Result.ok();
    }
    if (this.store.get(snapshot.id)?.version !== snapshot.version) return conflict(snapshot.id);
    this.store.set(snapshot.id, { ...snapshot, version: snapshot.version + 1 });
    return Result.ok();
  }

  async delete(expense: Expense): Promise<IResult> {
    const snapshot = expense.toSnapshot();
    if (this.store.get(snapshot.id)?.version !== snapshot.version) return conflict(snapshot.id);
    this.store.delete(snapshot.id);
    return Result.ok();
  }
}

const conflict = (id: string): IResult =>
  Result.fail(new ConcurrencyConflictException('Ledger', 'The expense has changed', { id }));

/** The balances kept in a Map, per group and member: the double the unit tests use for the balances. */
export type InMemoryBalanceStore = Map<string, Map<string, number>>;

export class InMemoryBalances implements IBalanceCounts, IBalanceQueries {
  constructor(private store: InMemoryBalanceStore = new Map()) {}

  async count(expense: Expense): Promise<void> {
    this.apply(expense, 1);
  }

  async uncount(expense: Expense): Promise<void> {
    this.apply(expense, -1);
  }

  private apply(expense: Expense, sign: 1 | -1): void {
    const group = this.store.get(expense.groupId.value) ?? new Map<string, number>();
    for (const { memberId, change } of expense.balanceChanges()) {
      group.set(memberId.value, (group.get(memberId.value) ?? 0) + sign * change);
    }
    this.store.set(expense.groupId.value, group);
  }

  async balancesOf(groupId: string): Promise<MemberBalanceReadModel[]> {
    return [...(this.store.get(groupId) ?? new Map<string, number>())].map(([memberId, balance]) => ({
      memberId,
      balance,
    }));
  }
}

/**
 * The group members a test gives: a Map from a group's id to its members in join order, the owner first (as Groups keeps
 * them), so the first member is the owner.
 */
export class InMemoryGroupMembers implements IGroupMembers {
  constructor(private members: Map<string, string[]>) {}

  async membersOf(groupId: string): Promise<Id[]> {
    return (this.members.get(groupId) ?? []).map(memberId => new Id(memberId));
  }

  async isMember(groupId: string, accountId: Id): Promise<boolean> {
    return (this.members.get(groupId) ?? []).includes(accountId.value);
  }

  async roleOf(groupId: string, accountId: Id): Promise<GroupRole | null> {
    const members = this.members.get(groupId) ?? [];
    if (!members.includes(accountId.value)) return null;
    return members[0] === accountId.value ? 'owner' : 'member';
  }

  /** The test gives only the current members, so a former one is not known here: it is a member only while it is given. */
  async hasBeenMember(groupId: string, accountId: Id): Promise<boolean> {
    return (this.members.get(groupId) ?? []).includes(accountId.value);
  }

  /** The test gives no departures, so no balance has passed: the balances are the ones the expenses make. */
  async passedBalancesOf(_groupId: string): Promise<PassedBalance[]> {
    return [];
  }
}
