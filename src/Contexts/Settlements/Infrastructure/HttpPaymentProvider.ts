import { IResult, Result } from '@Architecture/Domain';

import { IPaymentProvider, PaymentLink } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import { ProviderUnavailableException } from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

/** How long the provider may take to answer a payment before the settlement is refused (request 13): 5 seconds. */
export const PROVIDER_TIMEOUT_MS = 5000;

/**
 * The payment provider over its HTTP API (request 13, request 15, request 16, docs/adr/0014, docs/adr/0015, docs/adr/0016):
 * `POST {PROVIDER_URL}/payments` with `{ reference, amount, currency, payee }`, answered `201 { id, payUrl, fee }` (request 38: the fee is a whole
 * amount of 0 or more, and an answer without one is refused);
 * `POST {PROVIDER_URL}/payments/{paymentId}/refunds` with `{ reference }`, answered `201 { id }`; and
 * `GET {PROVIDER_URL}/accounts/{id}`, answered `200 { id }` when it knows the payout account, `404` when it does not. Any other answer, a body
 * that is not that, a failure to reach it, or no answer within 5 seconds, is the refusal ProviderUnavailable, and nothing is kept. The base is
 * read at each request, from the environment, as the adapter needs it: no `PROVIDER_URL` refuses every call.
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
    payee: string;
  }): Promise<IResult<PaymentLink>> {
    const answer = await this.#call('POST', '/payments', request);
    if (answer?.status !== 201 || !isPaymentLink(answer.body)) return Result.fail(new ProviderUnavailableException());
    return Result.ok({ id: answer.body.id, payUrl: answer.body.payUrl, fee: answer.body.fee });
  }

  async refundPayment({ paymentId, reference }: { paymentId: string; reference: string }): Promise<IResult<undefined>> {
    const answer = await this.#call('POST', `/payments/${encodeURIComponent(paymentId)}/refunds`, { reference });
    if (answer?.status !== 201 || !hasId(answer.body)) return Result.fail(new ProviderUnavailableException());
    return Result.ok(undefined);
  }

  async findPayoutAccount(accountId: string): Promise<IResult<string | undefined>> {
    const answer = await this.#call('GET', `/accounts/${encodeURIComponent(accountId)}`);
    if (answer?.status === 404) return Result.ok(undefined);
    if (answer?.status !== 200 || !hasId(answer.body) || answer.body.id !== accountId) {
      return Result.fail(new ProviderUnavailableException());
    }
    return Result.ok(answer.body.id);
  }

  /**
   * The status and the body the provider answered, or `undefined` when the base is not set, the provider cannot be reached, or it does not
   * answer in time. A body that is not JSON is `undefined` too, and so is a body of an answer that has none.
   */
  async #call(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
  ): Promise<{ status: number; body: unknown } | undefined> {
    const base = this.baseUrl()?.replace(/\/+$/, '');
    if (!base) return undefined;
    try {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: payload === undefined ? {} : { 'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await response.text();
      return { status: response.status, body: parseJson(text) };
    } catch {
      return undefined;
    }
  }
}

const parseJson = (text: string): unknown => {
  try {
    return text.length === 0 ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
};

const hasId = (body: unknown): body is { id: string } =>
  typeof body === 'object' &&
  body !== null &&
  typeof (body as { id?: unknown }).id === 'string' &&
  (body as { id: string }).id.length > 0;

/** A payment link answer: an id, a link, and the fee the provider takes, a whole amount of 0 or more; an answer without a fee is not one (request 38). */
const isPaymentLink = (body: unknown): body is PaymentLink => {
  if (!hasId(body)) return false;
  const { payUrl, fee } = body as unknown as Record<string, unknown>;
  return typeof payUrl === 'string' && payUrl.length > 0 && Number.isInteger(fee) && (fee as number) >= 0;
};
