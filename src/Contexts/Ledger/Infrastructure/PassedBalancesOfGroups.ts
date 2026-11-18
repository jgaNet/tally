import { IGroupQueries } from '@Contexts/Groups/Domain/IGroupQueries';
import { IPassedBalances, PassedBalance } from '@Contexts/Ledger/Application/IPassedBalances';

/**
 * Answers Ledger's `IPassedBalances` port over Groups' read model (CTX-CONTRACTS, ADR 25): the balances that passed to the owner when a member
 * left, in Ledger's words (the member who left, when, the amount). It is the one place Ledger reads Groups' passes for the audit, and only the
 * read model's `passesOf`; Ledger's Domain never imports Groups. The read model is given as a function, read at a request (ADR 7).
 */
export class PassedBalancesOfGroups implements IPassedBalances {
  constructor(private readonly groups: () => Pick<IGroupQueries, 'passesOf'>) {}

  async passedOf(groupId: string): Promise<PassedBalance[]> {
    return (await this.groups().passesOf(groupId)).map(pass => ({
      id: pass.id,
      at: pass.at,
      memberId: pass.from,
      amount: pass.amount,
    }));
  }
}
