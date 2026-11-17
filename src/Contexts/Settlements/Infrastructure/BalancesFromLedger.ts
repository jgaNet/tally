import { IGroupBalances } from '@Contexts/Settlements/Application/IGroupBalances';
import { MemberBalance } from '@Contexts/Settlements/Domain/Settlement/SuggestedSettlements';
import { IBalanceRoster } from '@Contexts/Ledger/Domain/Expense/Ports/IBalanceRoster';

/** Ledger's balances read model, as Ledger gives it to the other contexts: the type the wiring of Settlements is given. */
export type BalanceRoster = IBalanceRoster;

/**
 * The balances of a group's members, answered over Ledger's balances read model (ADR 9): Settlements' port `IGroupBalances` is
 * built on the read model Ledger gives, in one snapshot, so the suggestion reads what the ledger keeps and no domain imports Ledger.
 */
export class BalancesFromLedger implements IGroupBalances {
  constructor(private readonly balances: BalanceRoster) {}

  async balancesOf(groupId: string): Promise<MemberBalance[]> {
    return this.balances.balancesOf(groupId);
  }
}
