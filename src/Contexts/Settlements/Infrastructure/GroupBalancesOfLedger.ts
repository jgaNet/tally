import { IBalanceQueries } from '@Contexts/Ledger/Domain/IBalanceQueries';
import { IGroupBalances } from '@Contexts/Settlements/Application/IGroupBalances';

/**
 * Answers Settlements' `IGroupBalances` port over Ledger's balances read model, its Domain port `IBalanceQueries` (CTX-CONTRACTS,
 * ADR 10): the balances of a group, in the one statement Ledger gives for the whole group. It is the one place Settlements
 * reads Ledger, and only that read model; Settlements' Domain never imports Ledger. The read model is given as a function, read
 * when a request comes and not when the modules are built (ADR 7).
 */
export class GroupBalancesOfLedger implements IGroupBalances {
  constructor(private readonly ledger: () => Pick<IBalanceQueries, 'balancesOf'>) {}

  balancesOf(groupId: string): Promise<ReadonlyMap<string, number>> {
    return this.ledger().balancesOf(groupId);
  }
}
