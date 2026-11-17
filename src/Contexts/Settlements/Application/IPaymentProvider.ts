import { ProviderPayment } from '@Contexts/Settlements/Domain/Settlement/Settlement';

/** What Settlements asks the provider for a payment: the settlement's id as its reference, the amount, and the group's currency. */
export interface PaymentRequest {
  readonly reference: string;
  readonly amount: number;
  readonly currency: string;
}

/**
 * The payment provider, as Settlements asks it (conventions/domain.yaml, feature 13, the storm's `PaymentProvider`): a port Settlements
 * owns in its Application layer, named for what it decides: a payment link for a reference and an amount. `requestPayment` answers the
 * provider's payment (its id and the link the payer pays at), or `undefined` when the provider did not give one: any answer but a
 * `201 { id, payUrl }`, no answer within 5 seconds, or none configured. It never throws. The adapter is Settlements' infrastructure, so
 * no domain knows the provider's API, and the book takes or refuses its plain answer (DOMAIN-NON-DETERMINISM).
 */
export interface IPaymentProvider {
  requestPayment(request: PaymentRequest): Promise<ProviderPayment | undefined>;
}
