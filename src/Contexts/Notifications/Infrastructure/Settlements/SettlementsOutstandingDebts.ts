import { IOutstandingDebtQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/IOutstandingDebtQueries';

import { OutstandingDebt } from '@Contexts/Notifications/Domain/DebtWatch/DTOs';
import { IOutstandingDebts } from '@Contexts/Notifications/Domain/DebtWatch/Ports/IOutstandingDebts';

/**
 * Notifications' port onto Settlements (ADR 10, T9), answered over Settlements' read model: what each current member of each
 * group still owes, in Notifications' own words. Settlements counts it (the paid settlements through Ledger, and the payments
 * waiting at the provider as paid); this only translates it.
 */
export class SettlementsOutstandingDebts implements IOutstandingDebts {
  constructor(private debts: IOutstandingDebtQueries) {}

  async owing(): Promise<OutstandingDebt[]> {
    return (await this.debts.owing()).map(({ groupId, memberId, currency, owes }) => ({
      groupId,
      memberId,
      currency,
      owes,
    }));
  }
}
