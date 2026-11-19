import { convertAtRate, minorUnitDecimals } from './index';

describe('the minor unit of a currency (ADR 38)', () => {
  it('has no decimals for JPY and KRW, two for the six that count in hundredths, three for KWD and BHD', () => {
    for (const code of ['JPY', 'KRW']) expect(minorUnitDecimals(code)).toBe(0);
    for (const code of ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD']) expect(minorUnitDecimals(code)).toBe(2);
    for (const code of ['KWD', 'BHD']) expect(minorUnitDecimals(code)).toBe(3);
  });

  it('is a programming error to ask for a currency that is not one of Tally', () => {
    expect(() => minorUnitDecimals('CNY')).toThrow("CNY is not one of Tally's currencies");
  });
});

describe('converting an amount between currencies of different precision (request 40)', () => {
  it('counts 12.50 euros in yen at 161.5: 2018.75 yen, so 2019', () => {
    expect(convertAtRate(1250, '161.5', 'EUR', 'JPY')).toBe(2019);
  });

  it('counts 10 dollars in dinars at 0.3075: 3.075 dinars, so 3075', () => {
    expect(convertAtRate(1000, '0.3075', 'USD', 'KWD')).toBe(3075);
  });

  it('counts 10 000 yen in euros at 0.0062: 62 euros, so 6200', () => {
    expect(convertAtRate(10000, '0.0062', 'JPY', 'EUR')).toBe(6200);
  });

  it('rounds a half up in the group currency: 0.50 euro at 1 is half a yen, so 1 yen, and 0.40 euro is 0 yen', () => {
    expect(convertAtRate(50, '1', 'EUR', 'JPY')).toBe(1);
    expect(convertAtRate(40, '1', 'EUR', 'JPY')).toBe(0);
  });

  it('keeps between two currencies that count in hundredths what it was: the amount times the rate, a half up', () => {
    expect(convertAtRate(5, '0.5', 'USD', 'EUR')).toBe(3);
    expect(convertAtRate(4, '0.5', 'USD', 'EUR')).toBe(2);
    expect(convertAtRate(100, '1.005', 'EUR', 'GBP')).toBe(101);
  });
});
