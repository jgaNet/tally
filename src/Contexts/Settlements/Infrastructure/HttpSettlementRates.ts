import { ISettlementRates } from '@Contexts/Settlements/Application/Ports/ISettlementRates';
import { OfferedRate } from '@Contexts/Settlements/Domain/Settlement/OriginalPayment';

/** How long the rates service may take to answer a rate before there is none (request 39): 5 seconds, as for the provider. */
export const SETTLEMENT_RATES_TIMEOUT_MS = 5000;

const NONE: OfferedRate = { kind: 'none' };
const RATE_SHAPE = /^\d+(\.\d{1,6})?$/;

/**
 * The rates service over its HTTP API, as Settlements reads it (request 39, docs/adr/0038): `GET {RATES_URL}/rates/{from}/{to}?date={date}`,
 * answered `200 { rate }` with the rate, a decimal number in a string, greater than 0, of at most 6 digits after the point; `404` when it has no
 * rate. Any other answer, a body that is not that, a failure to reach it, or no answer within 5 seconds, is no rate (`none`). The base is read at
 * each request, from the environment: with no `RATES_URL` no rate is offered, and a settlement in another currency is refused.
 */
export class HttpSettlementRates implements ISettlementRates {
  constructor(
    private readonly baseUrl: () => string | undefined = () => process.env.RATES_URL,
    private readonly timeoutMs: number = SETTLEMENT_RATES_TIMEOUT_MS,
  ) {}

  async offeredRate({ from, to, date }: { from: string; to: string; date: string }): Promise<OfferedRate> {
    const base = this.baseUrl()?.replace(/\/+$/, '');
    if (!base) return NONE;
    try {
      const response = await fetch(
        `${base}/rates/${encodeURIComponent(from)}/${encodeURIComponent(to)}?date=${encodeURIComponent(date)}`,
        { method: 'GET', signal: AbortSignal.timeout(this.timeoutMs) },
      );
      if (response.status !== 200) return NONE;
      const body = parseJson(await response.text());
      const rate = typeof body === 'object' && body !== null ? (body as { rate?: unknown }).rate : undefined;
      return typeof rate === 'string' && RATE_SHAPE.test(rate) && !/^0+(\.0+)?$/.test(rate)
        ? { kind: 'offered', rate }
        : NONE;
    } catch {
      return NONE;
    }
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};
