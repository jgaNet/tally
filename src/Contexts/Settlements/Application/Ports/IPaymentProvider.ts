import { KnownPayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

/**
 * What the provider is asked for a payment: the settlement's id as its reference, the amount, the group's currency, and the
 * payee's payout account at the provider (the account the money goes to).
 */
export interface PaymentLinkRequest {
  reference: string;
  amount: number;
  currency: string;
  payee: string;
}

/** The provider's answer to a payment: its id for the payment, and the link the payer pays at. */
export interface PaymentLink {
  paymentId: string;
  payUrl: string;
}

/** What the provider is asked to refund: the provider's id for the payment, and the settlement's id as the reference. */
export interface RefundRequest {
  paymentId: string;
  reference: string;
}

/**
 * Settlements' port to the payment provider, which Settlements owns (the storm's T2): a payment link for a reference and an amount,
 * a refund of a payment, and whether the provider knows a payout account (request 16). Its answers are plain values the aggregates
 * take or refuse; a missing link (`null`) is any answer that is not the provider's `201`, one that does not come within its limit,
 * or no provider configured at all. A refund is accepted (`true`) only when the provider answers `201` with the refund's id, and is
 * refused (`false`) otherwise. A payout account is known only when the provider answers `200` with the account's id; any other answer,
 * or no answer within the limit, is `null`.
 */
export interface IPaymentProvider {
  requestPaymentLink(request: PaymentLinkRequest): Promise<PaymentLink | null>;
  requestRefund(request: RefundRequest): Promise<boolean>;
  payoutAccountOf(accountId: string): Promise<KnownPayoutAccount | null>;
}
