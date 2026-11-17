import { IMemberBalances } from '@Contexts/Groups/Application/IMemberBalances';
import { IBalanceQueries } from '@Contexts/Ledger/Domain/IBalanceQueries';

/**
 * Answers Groups' `IMemberBalances` port over Ledger's balances read model, its Domain port `IBalanceQueries` (CTX-CONTRACTS,
 * ADR 7): the balance of a member in a group, read in the one statement Ledger gives for the whole group. It is the one place
 * Groups reads Ledger; its Domain never imports Ledger. The read model is given as a function, read when a member asks to leave and not when the
 * modules are built: the two wirings refer to each other (ADR 7), and each reads the other only at a request.
 */
export class BalancesOfLedger implements IMemberBalances {
  constructor(private readonly ledger: () => Pick<IBalanceQueries, 'balancesOf'>) {}

  async balanceOf(groupId: string, memberId: string): Promise<number> {
    const balances = await this.ledger().balancesOf(groupId);
    return balances.get(memberId) ?? 0;
  }
}
