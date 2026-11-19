import { CURRENCY_CODES, convertMinorUnits, isCurrencyCode, minorUnitsPerUnit } from '@SharedKernel/Domain';

describe('Currency: Tally’s currencies and their minor units (request 40, ADR 30)', () => {
  it('has the six that count in hundredths, the two with no minor unit and the two in thousandths', () => {
    expect([...CURRENCY_CODES].sort()).toEqual(
      ['AUD', 'BHD', 'CAD', 'CHF', 'EUR', 'GBP', 'JPY', 'KRW', 'KWD', 'USD'].sort(),
    );
    expect(minorUnitsPerUnit('EUR')).toBe(100);
    expect(minorUnitsPerUnit('JPY')).toBe(1);
    expect(minorUnitsPerUnit('KRW')).toBe(1);
    expect(minorUnitsPerUnit('KWD')).toBe(1000);
    expect(minorUnitsPerUnit('BHD')).toBe(1000);
  });

  it('knows its own codes and no others', () => {
    expect(isCurrencyCode('JPY')).toBe(true);
    expect(isCurrencyCode('XXX')).toBe(false);
    expect(isCurrencyCode('constructor')).toBe(false);
    expect(isCurrencyCode(undefined)).toBe(false);
  });
});

describe('convertMinorUnits: what one unit of each currency is worth in the other (request 40)', () => {
  it('is the amount times the rate between two currencies that count in the same minor unit', () => {
    expect(convertMinorUnits({ amount: 1000, from: 'USD', to: 'EUR', rate: '1.1' })).toBe(1100);
    expect(convertMinorUnits({ amount: 2500, from: 'CHF', to: 'EUR', rate: '0.9542' })).toBe(2386);
  });

  it('writes an amount in the group’s minor unit: 12.50 euros at 161.5 yen to the euro is 2019 yen', () => {
    expect(convertMinorUnits({ amount: 1250, from: 'EUR', to: 'JPY', rate: '161.5' })).toBe(2019);
  });

  it('writes an amount in thousandths: 10 dollars at 0.3075 dinars to the dollar is 3075', () => {
    expect(convertMinorUnits({ amount: 1000, from: 'USD', to: 'KWD', rate: '0.3075' })).toBe(3075);
  });

  it('writes an amount in hundredths: 10 000 yen at 0.0062 euros to the yen is 6200', () => {
    expect(convertMinorUnits({ amount: 10000, from: 'JPY', to: 'EUR', rate: '0.0062' })).toBe(6200);
  });

  it('rounds to the nearest whole number of the minor unit, a half up', () => {
    // half a yen (50 hundredths at 1 yen to the euro)
    expect(convertMinorUnits({ amount: 50, from: 'EUR', to: 'JPY', rate: '1' })).toBe(1);
    // below a half
    expect(convertMinorUnits({ amount: 49, from: 'EUR', to: 'JPY', rate: '1' })).toBe(0);
  });

  it('is exact where a float would not: 7 at 0.142857 is 0.999999', () => {
    expect(convertMinorUnits({ amount: 7, from: 'EUR', to: 'EUR', rate: '0.142857' })).toBe(1);
  });

  it('refuses a currency that is not Tally’s by throwing: a caller checks it first', () => {
    expect(() => convertMinorUnits({ amount: 1, from: 'XXX', to: 'EUR', rate: '1' })).toThrow();
  });
});
