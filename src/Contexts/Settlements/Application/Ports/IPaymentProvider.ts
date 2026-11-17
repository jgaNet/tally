import { PaymentLink } from '@Contexts/Settlements/Domain/Settlement/DTOs';

/** A payment the provider is asked for: the settlement's id as the reference, the amount, and the group's currency. */
export interface PaymentRequest {
  reference: string;
  amount: number;
  currency: string;
}

/**
 * Settlements' own port onto the payment provider, an outside system with an API of its own: a payment link for a reference and
 * an amount, where the payer pays. Its answer is a plain value the SettlementBook takes or refuses (DOMAIN-NON-DETERMINISM):
 * null when the provider did not give a link (it answered another way, did not answer within 5 seconds, or is not configured).
 */
export interface IPaymentProvider {
  requestPayment(request: PaymentRequest): Promise<PaymentLink | null>;
}
