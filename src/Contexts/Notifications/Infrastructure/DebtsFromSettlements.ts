import { IOutstandingDebts, OutstandingDebt } from '@Contexts/Notifications/Application/IOutstandingDebts';
import { IDebtRoster } from '@Contexts/Settlements/Domain/Settlement/Ports/IDebtRoster';

/**
 * `IOutstandingDebts`, answered over Settlements' read model (the storm's owned port, ADR 14): Notifications owns the port and asks it in
 * its own words; this adapter is its infrastructure over the other context's read model, which the composition root gives it, as
 * Ledger's adapter over Settlements' roster does. No domain imports Settlements, and the sweep reads nothing else of it (feature 18).
 */
export class DebtsFromSettlements implements IOutstandingDebts {
  constructor(private readonly roster: IDebtRoster) {}

  async debtsOf(): Promise<OutstandingDebt[]> {
    return (await this.roster.debtsOf()).map(({ groupId, memberId, owes, currency }) => ({
      groupId,
      memberId,
      owes,
      currency,
    }));
  }
}
