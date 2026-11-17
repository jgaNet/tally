import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { openBook } from '@Contexts/Settlements/Application/OpenBook';
import { IDebtRoster, OwedDebt } from '@Contexts/Settlements/Domain/Settlement/Ports/IDebtRoster';
import { MembersFromGroups, GroupRoster } from '@Contexts/Settlements/Infrastructure/MembersFromGroups';
import { BalanceRoster, BalancesFromLedger } from '@Contexts/Settlements/Infrastructure/BalancesFromLedger';
import { SqliteSettlementStore } from '@Contexts/Settlements/Infrastructure/SqliteSettlementStore';

/**
 * What every current member of every group still owes (feature 18, ADR 14): Settlements' read model of the debts, which Notifications'
 * sweep asks through its own port `OutstandingDebts`. Each group's book is opened as a settlement is decided against it: its current
 * members in the order they joined, the balances the ledger counts (the paid settlements included), and the payments waiting at the
 * provider counted as paid (request 13). A member's debt is what the book still says they owe, never less than 0. It reads the groups
 * through Groups' roster and the balances through Ledger's read model, both given to it, and no domain is imported.
 */
export class OutstandingDebtRoster implements IDebtRoster {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly groups: GroupRoster,
    private readonly balances: BalanceRoster,
  ) {}

  async debtsOf(): Promise<OwedDebt[]> {
    const store = new SqliteSettlementStore(this.database);
    const members = new MembersFromGroups(this.groups);
    const counted = new BalancesFromLedger(this.balances);
    const debts: OwedDebt[] = [];
    for (const groupId of await this.groups.groupIds()) {
      const book = await openBook(store, members, counted, groupId);
      if (!book) continue;
      for (const { memberId, balance } of book.stillOwed()) {
        debts.push({ groupId, memberId, owes: Math.max(0, -balance) });
      }
    }
    return debts;
  }
}
