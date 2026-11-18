import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';

/**
 * Groups' port onto Settlements, answered over Settlements' read model (ADR 11): whether a member pays or receives a
 * payment through the provider that has not ended, in Groups' own words. A member with one waiting does not leave.
 */
export class SettlementsWaitingPayments implements IWaitingPayments {
  constructor(private settlements: ISettlementQueries) {}

  async hasWaitingPaymentOf(groupId: string, memberId: string): Promise<boolean> {
    const open = await this.settlements.openProviderPaymentsIn(groupId);
    return open.some(payment => payment.from === memberId || payment.to === memberId);
  }

  async hasWaitingPaymentIn(groupId: string): Promise<boolean> {
    return (await this.settlements.openProviderPaymentsIn(groupId)).length > 0;
  }
}
