import { IResult } from '@Architecture/Domain';

/**
 * The payment provider, an outside system with an API of its own (ADR 8), as Settlements asks it: a payment link for a
 * reference (the settlement's id), an amount and a currency. Settlements owns the port; its adapter calls the provider over
 * HTTP, with a limit of 5 seconds, and answers a failed Result for anything the provider does not answer as asked.
 */
export interface IPaymentProvider {
  createPayment(payment: { reference: string; amount: number; currency: string }): Promise<IResult<PaymentLink>>;
  /**
   * Asks the provider to refund a payment whole (request 15, ADR 9): the provider's id of the payment, and the settlement's id
   * as the reference. A failed Result when the provider does not accept it; nothing is kept on the Tally side then.
   */
  refundPayment(refund: { paymentId: string; reference: string }): Promise<IResult>;
}

/** The provider's payment: its id at the provider, and the link where the payer pays. */
export interface PaymentLink {
  id: string;
  payUrl: string;
}
