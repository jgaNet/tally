import { CURRENCIES, Currency, decimalsOf, isCurrency } from '@SharedKernel/Domain/Currency';

describe('Currency, the currencies Tally counts in, each with its minor unit (request 40, ADR 25)', () => {
  it('lists ten currencies: six that count in hundredths, two with no minor unit, two in thousandths', () => {
    expect(CURRENCIES).toEqual(['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'KRW', 'KWD', 'BHD']);
    expect(CURRENCIES.map(code => decimalsOf(code))).toEqual([2, 2, 2, 2, 2, 2, 0, 0, 3, 3]);
  });

  it('knows a code Tally counts in, and no other', () => {
    expect(isCurrency('JPY')).toBe(true);
    expect(isCurrency('XYZ')).toBe(false);
    expect(isCurrency('eur')).toBe(false);
    expect(isCurrency('constructor')).toBe(false);
    expect(() => decimalsOf('XYZ')).toThrow();
  });

  it('gives its minor unit: 100 hundredths for EUR, 1 yen for JPY, 1000 thousandths for KWD', () => {
    expect(Currency.create('EUR').data?.minorUnit).toBe(100);
    expect(Currency.create('JPY').data?.minorUnit).toBe(1);
    expect(Currency.create('KWD').data?.minorUnit).toBe(1000);
    expect(Currency.create('BHD').data?.decimals).toBe(3);
  });

  it('is built through create(), which refuses a code Tally does not count in', () => {
    expect(Currency.create('XYZ').isFailure()).toBe(true);
    const yen = Currency.create('KRW');
    expect(yen.isSuccess() && yen.data.code).toBe('KRW');
  });
});
