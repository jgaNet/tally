import { describe, expect, it } from '@jest/globals';

import { Currency, convertMinorUnits, minorUnitsOf } from '@SharedKernel/Domain/Currency';

describe('Currency, with the minor unit of each currency (request 40)', () => {
  it.each([
    ['EUR', 2],
    ['USD', 2],
    ['GBP', 2],
    ['CHF', 2],
    ['CAD', 2],
    ['AUD', 2],
    ['JPY', 0],
    ['KRW', 0],
    ['KWD', 3],
    ['BHD', 3],
  ])('knows %s and its %i decimals', (code, decimals) => {
    expect(Currency.create(code).data?.value).toBe(code);
    expect(Currency.decimalsOf(code)).toBe(decimals);
  });

  it('has exactly ten codes', () => {
    expect([...Currency.CODES].sort()).toEqual(['AUD', 'BHD', 'CAD', 'CHF', 'EUR', 'GBP', 'JPY', 'KRW', 'KWD', 'USD']);
  });

  it('refuses a code that is not Tally’s, by name, and any case but the exact one', () => {
    for (const raw of ['NOK', 'eur', '', 'constructor']) {
      expect(Currency.create(raw).error?.type).toBe('UnsupportedCurrency');
    }
  });

  it('counts a whole number of the minor unit: 20 of a currency in its own units', () => {
    expect(minorUnitsOf('EUR', 20)).toBe(2000);
    expect(minorUnitsOf('JPY', 20)).toBe(20);
    expect(minorUnitsOf('KWD', 20)).toBe(20000);
  });

  it('converts between currencies by what one unit of each is worth, rounded half up (request 40)', () => {
    // 12.50 euros (1250) at 161.5 yen per euro is 2018.75 yen, so 2019
    expect(convertMinorUnits(1250n, 'EUR', 'JPY', 161_500_000n)).toBe(2019n);
    // 10 dollars (1000) at 0.3075 dinars per dollar is 3.075 dinars, so 3075 thousandths
    expect(convertMinorUnits(1000n, 'USD', 'KWD', 307_500n)).toBe(3075n);
    // 10 000 yen at 0.0062 euros per yen is 62 euros, so 6200 hundredths
    expect(convertMinorUnits(10_000n, 'JPY', 'EUR', 6_200n)).toBe(6200n);
  });

  it('keeps the conversion between two currencies of the same decimals as it was', () => {
    // 12.34 Swiss francs at 1.0625 euros each is 13.11125 euros, so 1311 hundredths
    expect(convertMinorUnits(1234n, 'CHF', 'EUR', 1_062_500n)).toBe(1311n);
    // half up: 1 at 0.5 is 0.5, so 1
    expect(convertMinorUnits(1n, 'USD', 'EUR', 500_000n)).toBe(1n);
    // 0.499999 is 0.4999995 at its rate: below a half, so 0
    expect(convertMinorUnits(1n, 'USD', 'EUR', 499_999n)).toBe(0n);
  });
});
