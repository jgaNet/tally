import { ISettlementRates, SettlementRateRequest } from '@Contexts/Settlements/Application/Ports/ISettlementRates';

/** The rates service's limit on an answer, in milliseconds: past it, the request is refused and no rate is offered. */
export const SETTLEMENT_RATES_TIMEOUT_MS = 5000;

/**
 * The rates service over its HTTP API, as Settlements asks it: `GET {RATES_URL}/rates/{from}/{to}?date={date}`, answered `200 { rate }`
 * when it offers one, and `404` when it has none. Any other answer, or no answer within the limit, is `null`. `RATES_URL` is read when a
 * rate is asked, so a server started without it offers no rate, and a settlement in another currency is refused.
 */
export class HttpSettlementRates implements ISettlementRates {
  constructor(
    private baseUrl: () => string | undefined = () => process.env.RATES_URL,
    private timeoutMs = SETTLEMENT_RATES_TIMEOUT_MS,
  ) {}

  async rateOn({ from, to, date }: SettlementRateRequest): Promise<string | null> {
    const base = this.baseUrl();
    if (!base) return null;
    try {
      const response = await fetch(`${base}/rates/${from}/${to}?date=${date}`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 200) return null;
      const body = (await response.json()) as { rate?: unknown };
      return typeof body.rate === 'string' ? body.rate : null;
    } catch {
      return null;
    }
  }
}
