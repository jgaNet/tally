import { IOutstandingDebts, OutstandingDebt } from '@Contexts/Notifications/Domain/Debt/Ports/IOutstandingDebts';
import { IMemberDebts } from '@Contexts/Settlements/Domain/Settlement/Ports/IMemberDebts';

/**
 * Notifications' OutstandingDebts, answered over Settlements' read side (ADR 12): the member debts Settlements' wiring
 * exports, translated into Notifications' own words. Notifications never reaches into Settlements' application or
 * infrastructure.
 */
export class SettlementsOutstandingDebts implements IOutstandingDebts {
  constructor(private readonly debts: IMemberDebts) {}

  async outstandingDebts(): Promise<OutstandingDebt[]> {
    return (await this.debts.owedByMember()).map(({ groupId, memberId, owed, currency }) => ({
      groupId,
      memberId,
      owed,
      currency,
    }));
  }
}
