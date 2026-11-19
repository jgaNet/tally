import { IResult } from '@Architecture/Domain';

/**
 * The payment provider, an outside system with an API of its own (ADR 8), as Settlements asks it: a payment link for a
 * reference (the settlement's id), an amount and a currency. Settlements owns the port; its adapter calls the provider over
 * HTTP, with a limit of 5 seconds, and answers a failed Result for anything the provider does not answer as asked.
 */
export interface IPaymentProvider {
  /**
   * A payment link for a settlement, paid to the payee's payout account at the provider (request 13, request 16): `payee` is
   * that account's id at the provider.
   */
  createPayment(payment: {
    reference: string;
    amount: number;
    currency: string;
    payee: string;
  }): Promise<IResult<PaymentLink>>;
  /**
   * Asks whether the provider knows a payout account (request 16, ADR 10): its answer is the account (`{ id }`), or null for an
   * account it does not know. A failed Result when it does not answer as asked, or at all.
   */
  findPayoutAccount(accountId: string): Promise<IResult<{ id: string } | null>>;
  /**
   * Asks the provider to refund a payment whole (request 15, ADR 9): the provider's id of the payment, and the settlement's id
   * as the reference. A failed Result when the provider does not accept it; nothing is kept on the Tally side then.
   */
  refundPayment(refund: { paymentId: string; reference: string }): Promise<IResult>;
}

/**
 * The provider's payment: its id at the provider, the link where the payer pays, and the provider's fee on it, a whole number in
 * the hundredths of the currency (request 38). An answer without a fee is not an answer.
 */
export interface PaymentLink {
  id: string;
  payUrl: string;
  fee: number;
}
