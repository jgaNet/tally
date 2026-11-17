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

/**
 * Settlements' port to the payment provider, which Settlements owns (the storm's T2): a payment link for a reference and an amount.
 * Its answer is a plain value the SettlementBook takes or refuses; `null` is any answer that is not the provider's `201`, one that
 * does not come within its limit, or no provider configured at all.
 */
export interface IPaymentProvider {
  requestPaymentLink(request: PaymentLinkRequest): Promise<PaymentLink | null>;
}
