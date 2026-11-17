import { ISettlementQueries } from '@Contexts/Settlements/Domain/ISettlementQueries';
import { ISettledAmounts } from '@Contexts/Ledger/Application/ISettledAmounts';

/**
 * Answers Ledger's `ISettledAmounts` port over Settlements' read model, its Domain port `ISettlementQueries` (CTX-CONTRACTS, ADR 11):
 * the settled transfers of a group, in the one statement Settlements gives for the whole group, turned into each member's net effect on
 * their balance. It is the one place Ledger reads Settlements, and only the read model's `settledOf`; Ledger's Domain never imports
 * Settlements. The read model is given as a function, read when a balance is read and not when the modules are built (ADR 7).
 */
export class SettledAmountsOfSettlements implements ISettledAmounts {
  constructor(private readonly settlements: () => Pick<ISettlementQueries, 'settledOf'>) {}

  async settledOf(groupId: string): Promise<ReadonlyMap<string, number>> {
    const net = new Map<string, number>();
    for (const transfer of await this.settlements().settledOf(groupId)) {
      net.set(transfer.from, (net.get(transfer.from) ?? 0) + transfer.amount);
      net.set(transfer.to, (net.get(transfer.to) ?? 0) - transfer.amount);
    }
    return net;
  }
}
