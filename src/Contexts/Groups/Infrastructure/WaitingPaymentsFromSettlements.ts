import { IWaitingPayments } from '@Contexts/Groups/Application/IMemberBalances';
import { IWaitingPaymentRoster } from '@Contexts/Settlements/Domain/Settlement/Ports/IWaitingPaymentRoster';

/** Settlements' read model of the payments waiting at the provider, as Settlements gives it to the other contexts: the type Groups is given. */
export type WaitingPaymentsRoster = IWaitingPaymentRoster;

/**
 * Whether a member has a payment waiting at the provider, answered over Settlements' read model (request 20, ADR 15): Groups' port
 * `IWaitingPayments` is built on the read model Settlements gives, so a member with a payment waiting cannot leave, and no domain
 * imports Settlements. Whether an account has one waiting in any group is answered the same way (feature 35).
 */
export class WaitingPaymentsFromSettlements implements IWaitingPayments {
  constructor(private readonly roster: WaitingPaymentsRoster) {}

  hasWaitingPayment(groupId: string, memberId: string): Promise<boolean> {
    return this.roster.hasWaitingPayment(groupId, memberId);
  }

  hasPaymentWaitingOf(accountId: string): Promise<boolean> {
    return this.roster.hasPaymentWaitingOf(accountId);
  }
}
