import { IOutstandingDebts } from '@Contexts/Notifications/Domain/Debt/Ports/IOutstandingDebts';
import { OutstandingDebt } from '@Contexts/Notifications/Domain/Debt/DTOs';
import { IOutstandingDebtQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/IOutstandingDebtQueries';

/**
 * Notifications' OutstandingDebts, answered over Settlements' read model (docs/adr/0018): what each member still owes, read through
 * Settlements' own port and translated here into Notifications' words. Nothing else of a debt crosses.
 */
export class OutstandingDebtsOfSettlements implements IOutstandingDebts {
  constructor(private readonly settlements: IOutstandingDebtQueries) {}

  async outstandingDebts(): Promise<OutstandingDebt[]> {
    const debts = await this.settlements.outstandingDebts();
    return debts.map(({ groupId, memberId, amount }) => ({ groupId, memberId, amount }));
  }
}
