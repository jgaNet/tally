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
  /**
   * A payment link for `amount` in `currency` to `payee`, the payee's payout account at the provider (request 16), whose reference is the
   * settlement's id; `undefined` when the provider gave none.
   */
  paymentLinkFor(payment: {
    reference: string;
    amount: number;
    currency: string;
    payee: string;
  }): Promise<PaymentLink | undefined>;
  /**
   * The provider's id of the payout account asked about, when the provider knows it (request 16); `undefined` when it does not, or
   * answered anything else, or not within its limit: the account is then refused.
   */
  payoutAccountOf(accountId: string): Promise<string | undefined>;
  /**
   * Asks the provider to refund a payment, whole, with the settlement's id as the reference (request 15); `true` when the provider
   * accepted it, `false` when it answered anything else, or not within its limit, or is not configured: the refund is then refused.
   */
  refundPayment(refund: { paymentId: string; reference: string }): Promise<boolean>;
}
