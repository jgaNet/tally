import { IResult } from '@Architecture/Domain';

/** The payment link the provider gave for a settlement: its id for the payment, and the link where the payer pays (request 13). */
export interface PaymentLink {
  id: string;
  payUrl: string;
}

/**
 * The payment provider, as Settlements needs it (docs/adr/0014, docs/adr/0015): a payment link for a reference (the settlement's id), an amount and
 * a currency, asked before the book records the settlement. Settlements owns the port, in its own words; an adapter in its
 * Infrastructure calls the provider's API. Any other answer, or none within 5 seconds, is the refusal ProviderUnavailable, and
 * nothing is kept. The answer is a plain value the book takes or refuses.
 */
export interface IPaymentProvider {
  requestPayment(request: { reference: string; amount: number; currency: string }): Promise<IResult<PaymentLink>>;
  /**
   * Asks the provider to refund a payment whole, named by the provider's id for it and the settlement's id as the reference (request 15,
   * docs/adr/0015). Any other answer, or none within 5 seconds, is the refusal ProviderUnavailable, and nothing changes.
   */
  refundPayment(request: { paymentId: string; reference: string }): Promise<IResult<undefined>>;
}
