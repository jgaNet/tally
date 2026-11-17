import { IOutstandingDebts, OutstandingDebt } from '@Contexts/Notifications/Application/Ports/IOutstandingDebts';
import { IOutstandingDebtsQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/IOutstandingDebtsQueries';

/**
 * Notifications' port to Settlements, answered over Settlements' read model (ADR 10): the debts the read model gives, as they are.
 * The read model is the one Settlements' wiring exports, and it is a function for the reason the other adapters' are (ADR 4): it is
 * read when the sweep asks, not while the wiring files are evaluated.
 */
export class OutstandingDebtsFromSettlements implements IOutstandingDebts {
  constructor(private settlements: () => IOutstandingDebtsQueries) {}

  async outstanding(): Promise<OutstandingDebt[]> {
    return this.settlements().outstanding();
  }
}
