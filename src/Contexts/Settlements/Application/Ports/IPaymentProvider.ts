import { IResult } from '@Architecture/Domain';

/**
 * The payment provider, an outside system with an API of its own (ADR 8), as Settlements asks it: a payment link for a
 * reference (the settlement's id), an amount and a currency. Settlements owns the port; its adapter calls the provider over
 * HTTP, with a limit of 5 seconds, and answers a failed Result for anything the provider does not answer as asked.
 */
export interface IPaymentProvider {
  createPayment(payment: { reference: string; amount: number; currency: string }): Promise<IResult<PaymentLink>>;
}

/** The provider's payment: its id at the provider, and the link where the payer pays. */
export interface PaymentLink {
  id: string;
  payUrl: string;
}
