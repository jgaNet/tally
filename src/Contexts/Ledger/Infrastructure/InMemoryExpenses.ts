import { Id, IResult, Result } from '@Architecture/Domain';

import { IBalanceCounts } from '@Contexts/Ledger/Application/Ports/IBalanceCounts';
import { IBalanceQueries } from '@Contexts/Ledger/Application/Ports/IBalanceQueries';
import { MemberBalanceReadModel } from '@Contexts/Ledger/Application/ReadModel/MemberBalanceReadModel';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { ExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/** The expenses kept in a Map: the double the unit tests use for the repository. */
export type InMemoryExpenseStore = Map<string, ExpenseSnapshot>;

export class InMemoryExpenseRepository implements IExpenseRepository {
  constructor(private store: InMemoryExpenseStore) {}

  async findById(id: Id): Promise<Expense | null> {
    const snapshot = this.store.get(id.value);
    return snapshot ? Expense.fromSnapshot(snapshot) : null;
  }

  async save(expense: Expense): Promise<IResult> {
    const snapshot = expense.toSnapshot();
    this.store.set(snapshot.id, snapshot);
    return Result.ok();
  }
}

/** The balances kept in a Map, per group and member: the double the unit tests use for the balances. */
export type InMemoryBalanceStore = Map<string, Map<string, number>>;

export class InMemoryBalances implements IBalanceCounts, IBalanceQueries {
  constructor(private store: InMemoryBalanceStore = new Map()) {}

  async count(expense: Expense): Promise<void> {
    const group = this.store.get(expense.groupId.value) ?? new Map<string, number>();
    for (const { memberId, change } of expense.balanceChanges()) {
      group.set(memberId.value, (group.get(memberId.value) ?? 0) + change);
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

/** The group members a test gives: a Map from a group's id to its members in join order. */
export class InMemoryGroupMembers implements IGroupMembers {
  constructor(private members: Map<string, string[]>) {}

  async membersOf(groupId: string): Promise<Id[]> {
    return (this.members.get(groupId) ?? []).map(memberId => new Id(memberId));
  }

  async isMember(groupId: string, accountId: Id): Promise<boolean> {
    return (this.members.get(groupId) ?? []).includes(accountId.value);
  }
}
