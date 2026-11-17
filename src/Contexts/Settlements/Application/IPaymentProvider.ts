import { ProviderPayment } from '@Contexts/Settlements/Domain/Settlement/Settlement';

/** What Settlements asks the provider for a payment: the settlement's id as its reference, the amount, and the group's currency. */
export interface PaymentRequest {
  readonly reference: string;
  readonly amount: number;
  readonly currency: string;
}

/**
 * The payment provider, as Settlements asks it (conventions/domain.yaml, features 13 and 15, the storm's `PaymentProvider`): a port
 * Settlements owns in its Application layer, named for what it decides: a payment link for a reference and an amount, and a refund of a
 * payment. `refundPayment` answers whether the provider accepted the refund (`201 { id }`, within 5 seconds); it never throws. `requestPayment` answers the
 * provider's payment (its id and the link the payer pays at), or `undefined` when the provider did not give one: any answer but a
 * `201 { id, payUrl }`, no answer within 5 seconds, or none configured. It never throws. The adapter is Settlements' infrastructure, so
 * no domain knows the provider's API, and the book takes or refuses its plain answer (DOMAIN-NON-DETERMINISM).
 */
export interface IPaymentProvider {
  requestPayment(request: PaymentRequest): Promise<ProviderPayment | undefined>;
  refundPayment(request: RefundRequest): Promise<boolean>;
}

/** What Settlements asks the provider to refund: the provider's id of the payment, and the settlement's id as the reference. */
export interface RefundRequest {
  readonly paymentId: string;
  readonly reference: string;
}
