import { IResult, Result } from '@Architecture/Domain';

import { IPaymentProvider, PaymentLink } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import { ProviderUnavailableException } from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

/** How long the provider may take to answer a payment before the settlement is refused (request 13): 5 seconds. */
export const PROVIDER_TIMEOUT_MS = 5000;

/**
 * The payment provider over its HTTP API (request 13, docs/adr/0014): `POST {PROVIDER_URL}/payments` with `{ reference, amount, currency }`,
 * answered `201 { id, payUrl }`. Any other answer, a body that is not that, a failure to reach it, or no answer within 5 seconds, is the
 * refusal ProviderUnavailable, and nothing is kept. The base is read at each request, from the environment, as the adapter needs it: no
 * `PROVIDER_URL` refuses every payment.
 */
export class HttpPaymentProvider implements IPaymentProvider {
  constructor(
    private readonly baseUrl: () => string | undefined = () => process.env.PROVIDER_URL,
    private readonly timeoutMs: number = PROVIDER_TIMEOUT_MS,
  ) {}

  async requestPayment(request: {
    reference: string;
    amount: number;
    currency: string;
  }): Promise<IResult<PaymentLink>> {
    const base = this.baseUrl()?.replace(/\/+$/, '');
    if (!base) return Result.fail(new ProviderUnavailableException());
    try {
      const response = await fetch(`${base}/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 201) return Result.fail(new ProviderUnavailableException());
      const body = (await response.json()) as unknown;
      if (!isPaymentLink(body)) return Result.fail(new ProviderUnavailableException());
      return Result.ok({ id: body.id, payUrl: body.payUrl });
    } catch {
      return Result.fail(new ProviderUnavailableException());
    }
  }
}

const isPaymentLink = (body: unknown): body is PaymentLink => {
  if (typeof body !== 'object' || body === null) return false;
  const { id, payUrl } = body as Record<string, unknown>;
  return typeof id === 'string' && id.length > 0 && typeof payUrl === 'string' && payUrl.length > 0;
};
