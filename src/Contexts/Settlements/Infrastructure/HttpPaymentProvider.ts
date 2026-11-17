import { IPaymentProvider, PaymentRequest } from '@Contexts/Settlements/Application/IPaymentProvider';
import { ProviderPayment } from '@Contexts/Settlements/Domain/Settlement/Settlement';

/** How long the provider has to answer a payment request, in milliseconds: past it, the request is refused (request 13). */
export const PROVIDER_TIMEOUT_MS = 5000;

/**
 * The payment provider over its HTTP API (feature 13): `POST {PROVIDER_URL}/payments` with `{ reference, amount, currency }`, answered
 * `201 { id, payUrl }`. Any other answer, no answer within the timeout, a body without a payment id and a link, or no base URL at all
 * (`PROVIDER_URL` is not set), answers `undefined`: the request is refused and nothing is kept. It never throws.
 */
export class HttpPaymentProvider implements IPaymentProvider {
  constructor(private readonly baseUrl: string | undefined) {}

  async requestPayment({ reference, amount, currency }: PaymentRequest): Promise<ProviderPayment | undefined> {
    if (!this.baseUrl) return undefined;
    try {
      const response = await fetch(`${this.baseUrl}/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference, amount, currency }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (response.status !== 201) return undefined;
      return linkOf(await response.json());
    } catch {
      return undefined;
    }
  }
}

/** The provider's `{ id, payUrl }`, when it says both as non-empty text; anything else is no link. */
function linkOf(answer: unknown): ProviderPayment | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const { id, payUrl } = answer as { id?: unknown; payUrl?: unknown };
  if (typeof id !== 'string' || id === '' || typeof payUrl !== 'string' || payUrl === '') return undefined;
  return { id, payUrl };
}
