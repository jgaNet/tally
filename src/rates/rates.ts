/** Where the rates service is. */
export interface RatesConfig {
  /** The base of the rates service's API, without a trailing slash. Empty when there is no rates service. */
  url: string;
  /** How long the rates service may take to answer, in milliseconds. */
  timeoutMs: number;
}

/** A rate as the rates service and a request write it: a decimal number, at most 6 digits after the point. */
const RATE_SHAPE = /^\d+(\.\d{1,6})?$/;
const RATE_DIGITS = 6;

/**
 * A rate in millionths, worked in integers so no product rounds early; `undefined` when the text is not a
 * decimal of up to 6 digits after the point, or is 0.
 */
export function millionthsOf(rate: string): bigint | undefined {
  if (!RATE_SHAPE.test(rate)) {
    return undefined;
  }
  const [whole, fraction = ''] = rate.split('.');
  const millionths = BigInt(whole + fraction.padEnd(RATE_DIGITS, '0'));
  return millionths === 0n ? undefined : millionths;
}

/**
 * The rate the rates service offers for one `from` in `to` on `date`, as it gives it, or `undefined`: when
 * there is no rates service, when it answers anything but `200 { rate }` with a valid rate, when it does not
 * answer within the timeout, or when it cannot be reached. Asking changes nothing.
 */
export async function offeredRate(
  config: RatesConfig,
  from: string,
  to: string,
  date: string,
): Promise<string | undefined> {
  if (config.url === '') {
    return undefined;
  }
  try {
    const response = await fetch(`${config.url}/rates/${from}/${to}?date=${encodeURIComponent(date)}`, {
      // Covers the whole exchange, the answer's body included.
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (response.status !== 200) {
      return undefined;
    }
    const answer = (await response.json()) as unknown;
    if (typeof answer !== 'object' || answer === null || !('rate' in answer)) {
      return undefined;
    }
    const rate = answer.rate;
    if (typeof rate !== 'string' || millionthsOf(rate) === undefined) {
      return undefined;
    }
    return rate;
  } catch {
    return undefined;
  }
}
