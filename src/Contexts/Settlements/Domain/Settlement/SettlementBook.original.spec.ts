import { RateOffer } from '@Contexts/Settlements/Domain/Settlement/OriginalAmount';
import { Id } from '@Architecture/Domain';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import {
  NoRateOffered,
  ProviderFeeOutOfRange,
  SettlementExceedsDebt,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const payer = new Id('payer');
const payee = new Id('payee');
const members = ['payer', 'payee'];
const balances = new Map([
  ['payer', -3000],
  ['payee', 3000],
]);
const chf = (amount: number, offer: RateOffer = { kind: 'offered', rate: '0.9542' }) => ({
  currency: 'CHF',
  amount,
  groupCurrency: 'EUR',
  offer,
});

describe('SettlementBook: a payment in another currency (request 39)', () => {
  it('records a cash settlement at the offered rate, with its amount in the group currency and the rate kept', () => {
    const book = SettlementBook.open(Id.generate(), 0);
    const recorded = book.recordCash({
      payer,
      payee,
      original: chf(2500),
      balances,
      members,
      groupArchived: false,
      at: NOW,
    });
    if (recorded.isFailure()) throw new Error('the settlement must be recorded');
    expect(recorded.data.amount).toBe(2386);
    expect(recorded.data.settled).toBe(2386);
    expect(recorded.data.original).toEqual({ currency: 'CHF', amount: 2500, rate: '0.9542' });
    expect(book.unsaved[0]?.original).toEqual({ currency: 'CHF', amount: 2500, rate: '0.9542' });
  });

  it('refuses a settlement with no rate offered, and keeps nothing', () => {
    const book = SettlementBook.open(Id.generate(), 0);
    const refused = book.recordCash({
      payer,
      payee,
      original: chf(2500, { kind: 'none' }),
      balances,
      members,
      groupArchived: false,
      at: NOW,
    });
    expect(refused.isFailure() && refused.error).toBeInstanceOf(NoRateOffered);
    expect(book.unsaved).toHaveLength(0);
  });

  it('refuses a converted amount more than is owed: what the rules of a settlement hold is the group currency', () => {
    const book = SettlementBook.open(Id.generate(), 0);
    const refused = book.recordCash({
      payer,
      payee,
      original: chf(4000),
      balances: new Map([
        ['payer', -3000],
        ['payee', 3000],
      ]),
      members,
      groupArchived: false,
      at: NOW,
    });
    expect(refused.isFailure() && refused.error).toBeInstanceOf(SettlementExceedsDebt);
  });

  it('asks the provider in the currency paid, and converts its fee at the settlement rate before the payer share', () => {
    const book = SettlementBook.open(Id.generate(), 0);
    const proposal = book.proposePayment({
      payer,
      payee,
      original: chf(2500),
      balances,
      members,
      payeeAccount: 'acct-payee',
      groupArchived: false,
    });
    if (proposal.isFailure()) throw new Error('the payment must be proposed');
    expect(proposal.data.amount).toBe(2386);
    expect(proposal.data.original).toEqual({ currency: 'CHF', amount: 2500, rate: '0.9542' });

    // The provider's fee is 100 hundredths of a franc: 95 in the group's currency, borne by the payee (the default policy).
    const kept = book.keepPayment(proposal.data, { id: 'prov-1', payUrl: 'https://pay.example/prov-1', fee: 100 }, NOW);
    if (kept.isFailure()) throw new Error('the payment must be kept');
    expect(kept.data.fee).toEqual({ amount: 95, borneBy: 'payee' });
    expect(kept.data.settled).toBe(2386);
    expect(kept.data.original).toEqual({ currency: 'CHF', amount: 2500, rate: '0.9542' });
  });

  it('refuses a provider fee at or above the amount paid in its currency, and keeps nothing', () => {
    const book = SettlementBook.open(Id.generate(), 0);
    const proposal = book.proposePayment({
      payer,
      payee,
      original: chf(2500),
      balances,
      members,
      payeeAccount: 'acct-payee',
      groupArchived: false,
    });
    if (proposal.isFailure()) throw new Error('the payment must be proposed');
    const kept = book.keepPayment(
      proposal.data,
      { id: 'prov-1', payUrl: 'https://pay.example/prov-1', fee: 2500 },
      NOW,
    );
    expect(kept.isFailure() && kept.error).toBeInstanceOf(ProviderFeeOutOfRange);
  });
});
