import { IWaitingPayments } from '@Contexts/Groups/Application/IWaitingPayments';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/ISettlementQueries';

/**
 * Answers Groups' `IWaitingPayments` port over Settlements' read model (CTX-CONTRACTS, ADR 16): whether a member has a payment through
 * the provider waiting, pending or being refunded in the group. It is the one place Groups reads Settlements, and only the read model's
 * `hasWaitingPayment`; Settlements' Domain is never imported by Groups' Application. The read model is given as a function, read when a
 * member asks to leave and not when the modules are built: the wirings refer to each other (ADR 7).
 */
export class WaitingPaymentsOfSettlements implements IWaitingPayments {
  constructor(private readonly settlements: () => Pick<ISettlementQueries, 'hasWaitingPayment'>) {}

  async waitingOf(groupId: string, memberId: string): Promise<boolean> {
    return this.settlements().hasWaitingPayment(groupId, memberId);
  }
}
