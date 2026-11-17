import { IBalanceQueries } from '@Contexts/Ledger/Domain/IBalanceQueries';
import { ISettledAmounts } from '@Contexts/Ledger/Application/ISettledAmounts';
import { IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';

/**
 * The balances of a group as Ledger reports them to every reader (request 12, ADR 11, ADR 16): what the expenses make each member owe or
 * be owed, plus what the group's settlements have paid since (`SettledAmounts`), plus what passed from members who left to their owner
 * (request 20, `passesOf`): a pass moves its amount from the member to the owner, so a member who left has 0 from the moment it left, and
 * the balances still add up to 0. A member who left and joins again keeps that 0 and counts only what is recorded from then on.
 */
export class BalancesCountingSettlements implements IBalanceQueries {
  constructor(
    private readonly expenses: Pick<IBalanceQueries, 'balancesOf'>,
    private readonly settled: ISettledAmounts,
    private readonly members: Pick<IGroupMembers, 'passesOf'>,
  ) {}

  async balancesOf(groupId: string): Promise<ReadonlyMap<string, number>> {
    const balances = new Map(await this.expenses.balancesOf(groupId));
    for (const [memberId, amount] of await this.settled.settledOf(groupId)) {
      balances.set(memberId, (balances.get(memberId) ?? 0) + amount);
    }
    for (const { from, to, amount } of await this.members.passesOf(groupId)) {
      balances.set(from, (balances.get(from) ?? 0) - amount);
      balances.set(to, (balances.get(to) ?? 0) + amount);
    }
    return balances;
  }
}
