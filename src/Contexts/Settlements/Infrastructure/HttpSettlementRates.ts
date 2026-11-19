import { ISettlementRates } from '@Contexts/Settlements/Application/Ports/ISettlementRates';
import { RateOffer } from '@Contexts/Settlements/Domain/Settlement/OriginalAmount';

/**
 * The rates service over HTTP (request 22, ADR 15), as Settlements asks it for a settlement in another currency (request 39):
 * `GET {RATES_URL}/rates/{from}/{to}?date={date}`, answered `200 { rate }`, the rate written as a decimal number in a string,
 * greater than 0, with at most 6 digits after the point. A `404`, any other answer, a rate that is not written so, or an answer
 * after 5 seconds is `none`: no rate is offered. With no `RATES_URL` at all, the answer is `unconfigured`, and nothing is asked.
 */
export class HttpSettlementRates implements ISettlementRates {
  private static readonly NONE: RateOffer = { kind: 'none' };
  private static readonly RATE = /^\d+(\.\d{1,6})?$/;

  constructor(
    private readonly baseUrl: string | undefined,
    private readonly timeoutMs: number = 5000,
  ) {}

  async rateOn({ from, to, date }: { from: string; to: string; date: string }): Promise<RateOffer> {
    if (!this.baseUrl) return { kind: 'unconfigured' };
    try {
      const url = `${this.baseUrl}/rates/${encodeURIComponent(from)}/${encodeURIComponent(to)}?date=${encodeURIComponent(date)}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (response.status !== 200) return HttpSettlementRates.NONE;
      const body = (await response.json()) as { rate?: unknown };
      if (typeof body.rate !== 'string' || !HttpSettlementRates.RATE.test(body.rate) || !/[1-9]/.test(body.rate)) {
        return HttpSettlementRates.NONE;
      }
      return { kind: 'offered', rate: body.rate };
    } catch {
      return HttpSettlementRates.NONE;
    }
  }
}
