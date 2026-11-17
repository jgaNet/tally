import { IResult, Result } from '@Architecture/Domain';

import { IPaymentProvider, PaymentLink } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import { ProviderUnavailableException } from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

/** How long the provider may take to answer a payment before the settlement is refused (request 13): 5 seconds. */
export const PROVIDER_TIMEOUT_MS = 5000;

/**
 * The payment provider over its HTTP API (request 13, request 15, docs/adr/0014, docs/adr/0015): `POST {PROVIDER_URL}/payments` with
 * `{ reference, amount, currency }`, answered `201 { id, payUrl }`; and `POST {PROVIDER_URL}/payments/{paymentId}/refunds` with
 * `{ reference }`, answered `201 { id }`. Any other answer, a body that is not that, a failure to reach it, or no answer within 5 seconds,
 * is the refusal ProviderUnavailable, and nothing is kept. The base is read at each request, from the environment, as the adapter needs it:
 * no `PROVIDER_URL` refuses every call.
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
    const body = await this.#post('/payments', request);
    if (!isPaymentLink(body)) return Result.fail(new ProviderUnavailableException());
    return Result.ok({ id: body.id, payUrl: body.payUrl });
  }

  async refundPayment({ paymentId, reference }: { paymentId: string; reference: string }): Promise<IResult<undefined>> {
    const body = await this.#post(`/payments/${encodeURIComponent(paymentId)}/refunds`, { reference });
    if (!hasId(body)) return Result.fail(new ProviderUnavailableException());
    return Result.ok(undefined);
  }

  /** The body the provider answers `201` with, or `undefined` for any other answer, a failure to reach it, or no answer in time. */
  async #post(path: string, payload: unknown): Promise<unknown> {
    const base = this.baseUrl()?.replace(/\/+$/, '');
    if (!base) return undefined;
    try {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 201) return undefined;
      return (await response.json()) as unknown;
    } catch {
      return undefined;
    }
  }
}

const hasId = (body: unknown): body is { id: string } =>
  typeof body === 'object' &&
  body !== null &&
  typeof (body as { id?: unknown }).id === 'string' &&
  (body as { id: string }).id.length > 0;

const isPaymentLink = (body: unknown): body is PaymentLink => {
  if (!hasId(body)) return false;
  const { payUrl } = body as unknown as Record<string, unknown>;
  return typeof payUrl === 'string' && payUrl.length > 0;
};
