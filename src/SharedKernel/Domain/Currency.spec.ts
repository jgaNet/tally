import { convertMinorUnits, CURRENCIES, decimalsOf, isCurrencyCode } from '@SharedKernel/Domain/Currency';

describe('the minor unit of a currency (request 40, docs/adr/0039)', () => {
  it('is none for yen and won, hundredths for most, thousandths for dinars', () => {
    expect(decimalsOf('JPY')).toBe(0);
    expect(decimalsOf('KRW')).toBe(0);
    for (const code of ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] as const) expect(decimalsOf(code)).toBe(2);
    expect(decimalsOf('KWD')).toBe(3);
    expect(decimalsOf('BHD')).toBe(3);
  });

  it('knows the ten currencies of Tally, by their codes', () => {
    expect(CURRENCIES).toHaveLength(10);
    expect(isCurrencyCode('KWD')).toBe(true);
    expect(isCurrencyCode('kwd')).toBe(false);
    expect(isCurrencyCode('XXX')).toBe(false);
  });
});

describe('convertMinorUnits, the amount in the other currency, in its minor unit', () => {
  it('converts between currencies of different precision by what one unit of each is worth (request 40)', () => {
    // 12.50 euros at 161.5 yen each is 2018.75 yen, which is 2019 yen.
    expect(convertMinorUnits(1250, 'EUR', '161.5', 'JPY')).toBe(2019);
    // 10 dollars at 0.3075 dinars each is 3.075 dinars, which is 3075 thousandths.
    expect(convertMinorUnits(1000, 'USD', '0.3075', 'KWD')).toBe(3075);
    // 10 000 yen at 0.0062 euros each is 62 euros, which is 6200 cents.
    expect(convertMinorUnits(10000, 'JPY', '0.0062', 'EUR')).toBe(6200);
  });

  it('gives what it gave between two currencies that count in hundredths: a half up, in integers', () => {
    expect(convertMinorUnits(1000, 'USD', '0.9545', 'EUR')).toBe(955);
    expect(convertMinorUnits(1234, 'CHF', '1.0625', 'EUR')).toBe(1311);
    expect(convertMinorUnits(1, 'CHF', '0.5', 'EUR')).toBe(1);
    expect(convertMinorUnits(1, 'CHF', '0.499999', 'EUR')).toBe(0);
  });

  it('rounds a half up where the group has no minor unit (yen) and where it has thousandths', () => {
    expect(convertMinorUnits(500, 'EUR', '0.5', 'JPY')).toBe(3); // 5 euros at 0.5 is 2.5 yen, a half up
    expect(convertMinorUnits(1, 'JPY', '0.0005', 'KWD')).toBe(1); // 0.0005 dinars, 0.5 thousandths, a half up
    expect(convertMinorUnits(1, 'JPY', '0.0004', 'KWD')).toBe(0);
  });

  it('is exact on amounts of the largest size, with no float on the way', () => {
    expect(convertMinorUnits(100_000_000, 'BHD', '2.123456', 'JPY')).toBe(212_346); // 100 000 dinars at 2.123456: 212 345.6 yen
  });
});
