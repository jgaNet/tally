import { convertMinorUnits, CURRENCIES, isCurrencyCode, minorUnitsPerUnit } from '@SharedKernel/Domain/Currency';

describe('Currency', () => {
  it('knows ten currencies, each with its minor unit', () => {
    expect(CURRENCIES).toHaveLength(10);
    expect(['JPY', 'KRW', 'KWD', 'BHD'].every(isCurrencyCode)).toBe(true);
    expect(isCurrencyCode('toString')).toBe(false);
    expect([minorUnitsPerUnit('EUR'), minorUnitsPerUnit('JPY'), minorUnitsPerUnit('KWD')]).toEqual([100, 1, 1000]);
  });

  it('converts by what one unit of each is worth, to the nearest whole number, a half up', () => {
    expect(convertMinorUnits(1250, 'EUR', 'JPY', '161.5')).toBe(2019);
    expect(convertMinorUnits(1000, 'USD', 'KWD', '0.3075')).toBe(3075);
    expect(convertMinorUnits(10_000, 'JPY', 'EUR', '0.0062')).toBe(6200);
    expect(convertMinorUnits(1000, 'CHF', 'EUR', '0.9545')).toBe(955);
    expect(convertMinorUnits(100, 'EUR', 'JPY', '0.5')).toBe(1);
  });
});
