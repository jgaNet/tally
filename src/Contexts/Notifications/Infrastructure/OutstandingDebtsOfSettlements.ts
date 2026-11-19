import { IOutstandingDebts, OutstandingDebt } from '@Contexts/Notifications/Application/IOutstandingDebts';
import { IOutstandingDebtQueries } from '@Contexts/Settlements/Domain/IOutstandingDebtQueries';

/**
 * Answers Notifications' `IOutstandingDebts` port over Settlements' read model, its Domain port `IOutstandingDebtQueries`
 * (CTX-CONTRACTS, ADR 15): what every current member of every group still owes, with the payments waiting at the provider counted as
 * paid. It is the one place Notifications reads Settlements, and only that read model; Notifications' Domain never imports it. The
 * read model is given as a function, read when a run comes and not when the modules are built (ADR 7).
 */
export class OutstandingDebtsOfSettlements implements IOutstandingDebts {
  constructor(private readonly settlements: () => IOutstandingDebtQueries) {}

  async outstandingDebts(): Promise<OutstandingDebt[]> {
    return (await this.settlements().outstandingDebts()).map(({ groupId, memberId, currency, owed }) => ({
      groupId,
      memberId,
      currency,
      owed,
    }));
  }
}
