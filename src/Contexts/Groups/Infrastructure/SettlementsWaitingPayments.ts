import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';
import { IMemberPaymentsWaiting } from '@Contexts/Settlements/Domain/Settlement/Ports/IMemberPaymentsWaiting';

/**
 * Groups' WaitingPayments, answered over Settlements' read side (ADR 13): whether a payment of the member waits at the
 * provider. Groups' composition root gives it Settlements' read for a command, so it reads inside the leave's transaction;
 * Groups never reaches into Settlements' application.
 */
export class SettlementsWaitingPayments implements IWaitingPayments {
  constructor(private readonly payments: IMemberPaymentsWaiting) {}

  hasWaitingPayments(groupId: string, accountId: string): Promise<boolean> {
    return this.payments.hasWaitingPayment(groupId, accountId);
  }
}
