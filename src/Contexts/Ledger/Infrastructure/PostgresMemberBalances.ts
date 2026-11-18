import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IBalanceCounts } from '@Contexts/Ledger/Application/Ports/IBalanceCounts';
import { IBalanceQueries } from '@Contexts/Ledger/Application/Ports/IBalanceQueries';
import { ISettledAmounts } from '@Contexts/Ledger/Application/Ports/ISettledAmounts';
import { IGroupMembers, PassedBalance } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { MemberBalanceReadModel } from '@Contexts/Ledger/Application/ReadModel/MemberBalanceReadModel';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IMemberBalancesQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IMemberBalancesQueries';
import { createLedgerTables } from '@Contexts/Ledger/Infrastructure/LedgerTables';

/**
 * What a passage (request 20) makes to a member's balance: the leaver gives up the balance it passed, which the owner takes. So
 * the leaver's balance is 0 once it left, and the owner's is what it was plus the leaver's, and the balances still add up to 0.
 */
const passageEffectOn = (passage: PassedBalance, memberId: string): number =>
  (passage.to.value === memberId ? passage.amount : 0) - (passage.from.value === memberId ? passage.amount : 0);

/**
 * The balances, in the application's file. `count` writes in the command's transaction, so the expense and its balances are
 * stored together or not at all. A balance is what the expenses give, plus what has been settled (ADR 7): the settlements are
 * read when a balance is read, through the port Ledger owns, and are never copied here. `balanceOf` is read inside a command's
 * transaction, which holds the file already; `balancesOf` is read outside any transaction, so it takes the file itself.
 */
export class PostgresMemberBalances implements IBalanceCounts, IBalanceQueries, IMemberBalancesQueries {
  constructor(
    private database: PostgresDatabase,
    private settled: ISettledAmounts,
    private groupMembers: IGroupMembers,
  ) {
    createLedgerTables(database);
  }

  async count(expense: Expense): Promise<void> {
    this.apply(expense, 1);
  }

  async uncount(expense: Expense): Promise<void> {
    this.apply(expense, -1);
  }

  private async apply(expense: Expense, sign: 1 | -1): Promise<void> {
    for (const { memberId, change } of expense.balanceChanges()) {
      await this.database.run(
        `INSERT INTO member_balances (group_id, member_id, balance) VALUES (?, ?, ?)
         ON CONFLICT (group_id, member_id) DO UPDATE SET balance = member_balances.balance + excluded.balance`,
        expense.groupId.value,
        memberId.value,
        sign * change,
      );
    }
  }

  /**
   * A member's balance in a group, read by Groups before the member leaves (ADR 4) and by the command that decides a settlement
   * (ADR 7): inside the transaction of the caller, so it takes no lock.
   */
  async balanceOf(groupId: string, memberId: string): Promise<number> {
    const recorded =
      (
        await this.database.get<{ balance: number }>(
          'SELECT balance FROM member_balances WHERE group_id = ? AND member_id = ?',
          groupId,
          memberId,
        )
      )?.balance ?? 0;
    const settled = (await this.settled.settledOf(groupId)).find(row => row.memberId === memberId);
    const passed = (await this.groupMembers.passedBalancesOf(groupId)).reduce(
      (total, passage) => total + passageEffectOn(passage, memberId),
      0,
    );
    return recorded + (settled?.amount ?? 0) + passed;
  }

  /**
   * Every member's balance in the group: the members with a row, and those a passage or a settlement names (the owner of a passage has
   * no row of its own when it only received one). Read inside the transaction of the caller, so it takes no lock.
   */
  async allBalancesOf(groupId: string): Promise<number[]> {
    const memberIds = new Set(
      (
        await this.database.all<{ member_id: string }>(
          'SELECT member_id FROM member_balances WHERE group_id = ?',
          groupId,
        )
      ).map(row => row.member_id),
    );
    for (const passage of await this.groupMembers.passedBalancesOf(groupId)) {
      memberIds.add(passage.from.value);
      memberIds.add(passage.to.value);
    }
    for (const settled of await this.settled.settledOf(groupId)) memberIds.add(settled.memberId);
    return Promise.all([...memberIds].map(memberId => this.balanceOf(groupId, memberId)));
  }

  async balancesOf(groupId: string): Promise<MemberBalanceReadModel[]> {
    const release = await this.database.lock();
    try {
      const balances = new Map<string, number>(
        (
          await this.database.all<{ member_id: string; balance: number }>(
            'SELECT member_id, balance FROM member_balances WHERE group_id = ?',
            groupId,
          )
        ).map(row => [row.member_id, row.balance]),
      );
      for (const settled of await this.settled.settledOf(groupId)) {
        balances.set(settled.memberId, (balances.get(settled.memberId) ?? 0) + settled.amount);
      }
      for (const passage of await this.groupMembers.passedBalancesOf(groupId)) {
        for (const memberId of [passage.from.value, passage.to.value]) {
          balances.set(memberId, (balances.get(memberId) ?? 0) + passageEffectOn(passage, memberId));
        }
      }
      return [...balances].map(([memberId, balance]) => ({ memberId, balance }));
    } finally {
      release();
    }
  }

  /**
   * The balances counted in one group are counted in the other (request 31): each member's row adds to the other group's, and the
   * merged group's rows are gone. The sums stay 0 in both groups, since they were 0 in the one. Runs in the reaction's transaction.
   */
  async moveGroup(fromGroupId: string, toGroupId: string): Promise<void> {
    await this.database.run(
      `INSERT INTO member_balances (group_id, member_id, balance)
       SELECT ?, member_id, balance FROM member_balances WHERE group_id = ?
       ON CONFLICT (group_id, member_id) DO UPDATE SET balance = member_balances.balance + excluded.balance`,
      toGroupId,
      fromGroupId,
    );
    await this.database.run('DELETE FROM member_balances WHERE group_id = ?', fromGroupId);
  }
}
