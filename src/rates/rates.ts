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

/**
 * An amount in the minor unit of one currency, with `fromDigits` decimal digits in it, at a rate in millionths, in the
 * minor unit of another, with `toDigits`: what one unit of the first is worth in the second, times the amount, written
 * in the second's minor unit, to the nearest whole number, a half rounded up. The two units differ by a power of ten,
 * which the product is scaled by. Worked in integers, so no product rounds early.
 */
export function convertedAmount(amount: number, millionths: bigint, fromDigits: number, toDigits: number): bigint {
  const scale = 10n ** BigInt(Math.max(0, toDigits - fromDigits));
  const divisor = 1_000_000n * 10n ** BigInt(Math.max(0, fromDigits - toDigits));
  const product = BigInt(amount) * millionths * scale;
  // The product over the divisor, to the nearest whole number, a half up: floor((2 * product + divisor) / (2 * divisor)).
  return (2n * product + divisor) / (2n * divisor);
}
