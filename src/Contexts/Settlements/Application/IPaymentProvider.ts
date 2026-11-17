/** The payment link the provider gave for a payment: its id there, and the page where the payer pays. */
export interface PaymentLink {
  id: string;
  payUrl: string;
}

/**
 * The payment provider, as Settlements needs it to take a payment (request 13, ADR 9, ADR 12): a port Settlements owns, in its own words,
 * answered by an adapter over the provider's API (`PaymentProviderOverHttp`, in this context's Infrastructure). The provider is an
 * outside system, so no Domain of it is imported here: the answer is a plain value, or `undefined` when it gave no link (it answered
 * anything else, or not within its limit, or it is not configured), which the use case refuses.
 */
export interface IPaymentProvider {
  /** A payment link for `amount` in `currency`, whose reference is the settlement's id; `undefined` when the provider gave none. */
  paymentLinkFor(payment: { reference: string; amount: number; currency: string }): Promise<PaymentLink | undefined>;
}
