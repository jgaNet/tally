import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';

/**
 * Groups' WaitingPayments, answered over Settlements' read model (request 20, docs/adr/0019): whether a payment of a member waits at the
 * provider in the group. Translated here into Groups' words: the account and a yes or no, nothing else of a settlement.
 */
export class WaitingPaymentsOfSettlements implements IWaitingPayments {
  constructor(private readonly settlements: ISettlementQueries) {}

  async paymentWaitingOf(groupId: string, accountId: string): Promise<boolean> {
    return this.settlements.providerWaitingOf(groupId, accountId);
  }

  async paymentWaitingOfAccount(accountId: string): Promise<boolean> {
    return this.settlements.providerWaitingOfAccount(accountId);
  }
}
