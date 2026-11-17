import { IBalanceQueries } from '@Contexts/Ledger/Domain/IBalanceQueries';
import { ISettledAmounts } from '@Contexts/Ledger/Application/ISettledAmounts';

/**
 * The balances of a group as Ledger reports them to every reader (request 12, ADR 11): what the expenses make each member owe or be
 * owed, plus what the group's settlements have paid since (`SettledAmounts`). A settlement is counted as soon as it is recorded; a
 * member's statement is not affected, as it lists expenses only. Both parts sum to 0, so the balances still do.
 */
export class BalancesCountingSettlements implements IBalanceQueries {
  constructor(
    private readonly expenses: Pick<IBalanceQueries, 'balancesOf'>,
    private readonly settled: ISettledAmounts,
  ) {}

  async balancesOf(groupId: string): Promise<ReadonlyMap<string, number>> {
    const balances = new Map(await this.expenses.balancesOf(groupId));
    for (const [memberId, amount] of await this.settled.settledOf(groupId)) {
      balances.set(memberId, (balances.get(memberId) ?? 0) + amount);
    }
    return balances;
  }
}
