import {
  RecordCashSettlementCommand,
  RequestProviderPaymentCommand,
  SettlementBook,
} from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

const at = new Date('2026-11-17T10:00:00.000Z');
const offered = (rate: string) => ({ kind: 'offered' as const, rate });

/** Bob (the payer) owes Ann (the payee) 10 000 in EUR, and pays 10 000 CHF, at 0.95, which is 9500. */
const cash = (overrides: Partial<RecordCashSettlementCommand> = {}): RecordCashSettlementCommand => ({
  by: 'ann',
  from: 'bob',
  original: { currency: 'CHF', amount: 10000 },
  groupCurrency: 'EUR',
  offered: offered('0.95'),
  members: ['ann', 'bob', 'cy'],
  balances: { payer: -10000, payee: 10000 },
  at,
  archived: false,
  suspended: false,
  ...overrides,
});

const provider = (overrides: Partial<RequestProviderPaymentCommand> = {}): RequestProviderPaymentCommand => ({
  by: 'bob',
  to: 'ann',
  original: { currency: 'CHF', amount: 10000 },
  groupCurrency: 'EUR',
  offered: offered('0.95'),
  members: ['ann', 'bob', 'cy'],
  balances: { payer: -10000, payee: 10000 },
  payoutAccount: 'ann-at-the-provider',
  at,
  archived: false,
  suspended: false,
  payeeDeleted: false,
  ...overrides,
});

const book = () => SettlementBook.fromSnapshot({ groupId: 'group-1', version: 0 });

describe('a settlement in another currency (request 39)', () => {
  it("records a cash one at the rate offered, its amount in the group's currency, and keeps what it was paid in and the rate", () => {
    const b = book();
    const recorded = b.recordCash(cash());
    expect(recorded.isSuccess()).toBe(true);
    expect(recorded.data).toMatchObject({
      from: 'bob',
      to: 'ann',
      amount: 9500,
      method: 'cash',
      status: 'paid',
      original: { currency: 'CHF', amount: 10000, rate: '0.95' },
    });
    // The audit and the balances count the amount in the group's currency.
    expect(b.audited[0]).toMatchObject({ action: 'settlement-paid', amount: 9500 });
  });

  it("leaves out original for a settlement in the group's currency, as before", () => {
    const recorded = book().recordCash(cash({ original: undefined, amount: 30, balances: { payer: -30, payee: 30 } }));
    expect(recorded.isSuccess() && recorded.data.original).toBeUndefined();
  });

  it('is refused, and nothing is kept, when no rate is offered', () => {
    const b = book();
    const refused = b.recordCash(cash({ offered: { kind: 'none' } }));
    expect(refused.error?.type).toBe('NoRateOffered');
    expect(b.recorded).toEqual([]);
    expect(b.audited).toEqual([]);
  });

  it("is refused when it is more than the payer still owes, in the group's currency", () => {
    // 11 000 CHF at 0.95 is 10 450, more than the 10 000 Bob owes Ann; 10 500 CHF is 9 975, which is not.
    expect(book().recordCash(cash({ original: { currency: 'CHF', amount: 11000 } })).error?.type).toBe(
      'SettlementExceedsDebt',
    );
    expect(
      book()
        .recordCash(cash({ original: { currency: 'CHF', amount: 10500 } }))
        .isSuccess(),
    ).toBe(true);
  });

  it('is refused when it is given both an amount and an original, or neither', () => {
    expect(book().recordCash(cash({ amount: 100 })).error?.type).toBe('InvalidSettlementAmount');
    expect(book().recordCash(cash({ original: undefined })).error?.type).toBe('InvalidSettlementAmount');
  });

  it("is refused, with its currency's reason, before any rate is needed for a currency that is not one of Tally", () => {
    expect(book().recordCash(cash({ original: { currency: 'XXX', amount: 100 } })).error?.type).toBe('UnknownCurrency');
  });

  it('asks the provider for what is paid, in its currency, and converts its fee at the same rate', () => {
    const b = book();
    const reserved = b.reserveProviderPayment(provider());
    expect(reserved.isSuccess() && reserved.data.payment).toEqual({ amount: 10000, currency: 'CHF' });
    expect(b.pending).toEqual([]);

    // The provider's fee is 300 CHF: 285 in EUR at 0.95, which the payee bears by default: the payer's part is none.
    const recorded = b.recordProviderPayment(provider(), {
      settlementId: reserved.isSuccess() ? reserved.data.settlementId : '',
      providerPaymentId: 'pay-1',
      payUrl: 'https://pay.example/pay-1',
      fee: 300,
    });
    expect(recorded.isSuccess() && recorded.data).toMatchObject({
      amount: 9500,
      original: { currency: 'CHF', amount: 10000, rate: '0.95' },
      fee: { amount: 285, borneBy: 'payee' },
    });
    expect(b.pending[0]).toMatchObject({ amount: 9500, settled: 9500 });
  });

  it("takes the payer's part of the converted fee off what it settles, once the owner says so", () => {
    const b = book();
    const decided = b.setFeePolicy({ by: 'ann', ownerId: 'ann', borneBy: 'payer', archived: false });
    expect(decided.isSuccess()).toBe(true);
    const reserved = b.reserveProviderPayment(provider());
    const recorded = b.recordProviderPayment(provider(), {
      settlementId: reserved.isSuccess() ? reserved.data.settlementId : '',
      providerPaymentId: 'pay-1',
      payUrl: 'https://pay.example/pay-1',
      fee: 300,
    });
    expect(recorded.isSuccess() && recorded.data).toMatchObject({ fee: { amount: 285, borneBy: 'payer' } });
    expect(b.pending[0]).toMatchObject({ amount: 9500, settled: 9215 });
  });

  it("refuses a provider fee that is not less than what is paid, in the payment's currency", () => {
    const b = book();
    const reserved = b.reserveProviderPayment(provider());
    const refused = b.recordProviderPayment(provider(), {
      settlementId: reserved.isSuccess() ? reserved.data.settlementId : '',
      providerPaymentId: 'pay-1',
      payUrl: 'https://pay.example/pay-1',
      fee: 10000,
    });
    expect(refused.error?.type).toBe('ProviderFeeNotAccepted');
    expect(b.pending).toEqual([]);
  });

  it('is refused before the provider is asked when no rate is offered', () => {
    expect(book().reserveProviderPayment(provider({ offered: { kind: 'none' } })).error?.type).toBe('NoRateOffered');
  });
});
