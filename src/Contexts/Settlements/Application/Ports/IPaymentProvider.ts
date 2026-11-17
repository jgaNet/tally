/** What the provider is asked for a payment: the settlement's id as its reference, the amount, and the group's currency. */
export interface PaymentLinkRequest {
  reference: string;
  amount: number;
  currency: string;
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
 * and a refund of a payment. Its answers are plain values the SettlementBook takes or refuses; a missing link (`null`) is any answer
 * that is not the provider's `201`, one that does not come within its limit, or no provider configured at all. A refund is accepted
 * (`true`) only when the provider answers `201` with the refund's id, and is refused (`false`) otherwise.
 */
export interface IPaymentProvider {
  requestPaymentLink(request: PaymentLinkRequest): Promise<PaymentLink | null>;
  requestRefund(request: RefundRequest): Promise<boolean>;
}
