import { ProviderPayment } from '@Contexts/Settlements/Domain/Settlement/Settlement';
import { ProviderPayoutAccount } from '@Contexts/Settlements/Domain/PayoutAccount/PayoutAccount';

/**
 * What Settlements asks the provider for a payment: the settlement's id as its reference, the amount, the group's currency, and the
 * provider's id of the payee's payout account the money goes to (request 16).
 */
export interface PaymentRequest {
  readonly reference: string;
  readonly amount: number;
  readonly currency: string;
  readonly payee: string;
}

/**
 * The payment provider, as Settlements asks it (conventions/domain.yaml, features 13, 15 and 16, the storm's `PaymentProvider`): a port
 * Settlements owns in its Application layer, named for what it decides: a payment link for a reference and an amount, a refund of a
 * payment, and whether it knows a payout account. `refundPayment` answers whether the provider accepted the refund (`201 { id }`, within
 * 5 seconds); it never throws. `requestPayment` answers the provider's payment (its id and the link the payer pays at), or `undefined`
 * when the provider did not give one: any answer but a `201 { id, payUrl }`, no answer within 5 seconds, or none configured. It never
 * throws. `payoutAccountFor` answers the provider's `{ id }` of an account it knows, or `undefined` for any other answer, no answer
 * within 5 seconds, or none configured (request 16). The adapter is Settlements' infrastructure, so no domain knows the provider's API,
 * and the book and the payout account take or refuse its plain answer (DOMAIN-NON-DETERMINISM).
 */
export interface IPaymentProvider {
  requestPayment(request: PaymentRequest): Promise<ProviderPayment | undefined>;
  refundPayment(request: RefundRequest): Promise<boolean>;
  payoutAccountFor(accountId: string): Promise<ProviderPayoutAccount | undefined>;
}

/** What Settlements asks the provider to refund: the provider's id of the payment, and the settlement's id as the reference. */
export interface RefundRequest {
  readonly paymentId: string;
  readonly reference: string;
}
