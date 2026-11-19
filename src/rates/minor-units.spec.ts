import { type Currency, minorUnitDigitsOf } from '../groups/validation';
import { convertedAmount } from './rates';

describe('converting between currencies with minor units of different sizes', () => {
  it.each([
    // [what, amount in its minor unit, rate in millionths, digits of its currency, digits of the other, answer]
    ['12.50 euros at 161.5 is 2018.75 yen, so 2019', 1250, 161_500_000n, 2, 0, 2019n],
    ['10 dollars at 0.3075 is 3.075 dinars, so 3075 thousandths', 1000, 307_500n, 2, 3, 3075n],
    ['10 000 yen at 0.0062 is 62 euros, so 6200 hundredths', 10_000, 6_200n, 0, 2, 6200n],
    ['1 dinar at 200 yen is 200 yen', 1000, 200_000_000n, 3, 0, 200n],
    ['12.50 euros at 1480.5 won is 18 506.25 won, so 18 506', 1250, 1_480_500_000n, 2, 0, 18506n],
    ['1 dinar at 2.95 euros is 2.95 euros, so 295 hundredths', 1000, 2_950_000n, 3, 2, 295n],
    ['50 cents at 1 is half a yen, so 1: a half rounded up', 50, 1_000_000n, 2, 0, 1n],
    ['49 cents at 1 is less than half a yen, so 0', 49, 1_000_000n, 2, 0, 0n],
    ['1000 at 0.9545 within the same digits is 954.5, so 955', 1000, 954_500n, 2, 2, 955n],
    ['the same currency at a rate of one is the amount', 1234, 1_000_000n, 2, 2, 1234n],
  ])('%s', (_, amount, millionths, fromDigits, toDigits, expected) => {
    expect(convertedAmount(amount, millionths, fromDigits, toDigits)).toBe(expected);
  });

  it('rounds once, on the whole product: 100 000 000 thousandths of a dinar at 0.000001 euros is 10 hundredths', () => {
    expect(convertedAmount(100_000_000, 1n, 3, 2)).toBe(10n);
  });

  it('gives each currency its minor unit: none for yen and won, hundredths for the six, thousandths for dinars', () => {
    const sixHundredths: Currency[] = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'];
    expect(sixHundredths.map(currency => minorUnitDigitsOf(currency))).toEqual([2, 2, 2, 2, 2, 2]);
    expect(minorUnitDigitsOf('JPY')).toBe(0);
    expect(minorUnitDigitsOf('KRW')).toBe(0);
    expect(minorUnitDigitsOf('KWD')).toBe(3);
    expect(minorUnitDigitsOf('BHD')).toBe(3);
  });
});
