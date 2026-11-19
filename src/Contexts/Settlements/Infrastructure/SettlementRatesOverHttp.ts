import { ISettlementRates } from '@Contexts/Settlements/Application/ISettlementRates';
import { isRate } from '@SharedKernel/Domain';

/** How long the rates service has to answer before no rate is offered (request 22, request 39). */
export const SETTLEMENT_RATES_TIMEOUT_MS = 5000;

/**
 * Answers Settlements' `ISettlementRates` port over the rates service's API (request 22): `GET {RATES_URL}/rates/{from}/{to}?date={date}`,
 * whose `200 { rate }` is the rate offered, written as request 21 writes one. Any other answer, a rate that is not one, a timeout, or a
 * network failure is no rate (`undefined`), and the settlement is refused by its name with nothing kept and the provider not asked. A server
 * with no `RATES_URL` has no rates service, so no rate is offered either. The URL is read when a request comes, not when the modules are
 * built (ADR 7), and is the base of the API without a trailing slash.
 */
export class SettlementRatesOverHttp implements ISettlementRates {
  constructor(
    private readonly baseUrl: () => string | undefined,
    private readonly timeoutMs: number = SETTLEMENT_RATES_TIMEOUT_MS,
  ) {}

  async rateFor({ from, to, date }: { from: string; to: string; date: string }): Promise<string | undefined> {
    const base = this.baseUrl();
    if (!base) return undefined;
    try {
      const url = `${base}/rates/${encodeURIComponent(from)}/${encodeURIComponent(to)}?date=${encodeURIComponent(date)}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (response.status !== 200) return undefined;
      const body = (await response.json()) as { rate?: unknown };
      return isRate(body.rate) ? body.rate : undefined;
    } catch {
      return undefined;
    }
  }
}
