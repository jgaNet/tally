import { NO_SERVICE, RateOffer, withinBand } from './Rate';
import { decideRecordExpense, RecordExpenseCommand } from './Expense.decision';

const ada = 'ada';
const grace = 'grace';
const now = new Date('2026-11-17T10:00:00Z');
const offering = (rate: string): RateOffer => ({ kind: 'rate', rate });
const facts = (offered: RateOffer) => ({ memberIds: [ada, grace], groupCurrency: 'EUR', offered });

/** A payment in CHF of 1000 hundredths, the rate left out unless given. */
const paid = (original: { rate?: string } = {}): RecordExpenseCommand =>
  ({
    description: 'Zurich dinner',
    date: '2026-11-16',
    split: { kind: 'equal', memberIds: [ada, grace] },
    payer: ada,
    original: { currency: 'CHF', amount: 1000, ...original },
  }) as RecordExpenseCommand;

describe('the band around the offered rate (request 22)', () => {
  it('takes a rate within 2 % of the one offered, both edges included, and refuses one beyond', () => {
    expect(withinBand('0.931', '0.95')).toBe(true);
    expect(withinBand('0.969', '0.95')).toBe(true);
    expect(withinBand('0.931', '0.95')).toBe(true);
    expect(withinBand('0.93', '0.95')).toBe(false);
    expect(withinBand('0.97', '0.95')).toBe(false);
  });

  it('compares in exact millionths, not in floating point', () => {
    // 2 % of 1.000000 is 0.02 exactly: 1.02 is at the edge, 1.020001 beyond it.
    expect(withinBand('1.02', '1')).toBe(true);
    expect(withinBand('1.020001', '1')).toBe(false);
    expect(withinBand('0.98', '1')).toBe(true);
    expect(withinBand('0.979999', '1')).toBe(false);
  });
});

describe('the rate an expense in another currency takes (request 22)', () => {
  it('takes the offered rate, as the service gives it, when its rate is left out', () => {
    const decision = decideRecordExpense(facts(offering('0.95')), paid(), now);
    expect(decision.isSuccess()).toBe(true);
    expect(decision.data?.state.original).toMatchObject({ currency: 'CHF', amount: 1000, rate: '0.95' });
    expect(decision.data?.state.amount.value).toBe(950);
  });

  it('takes a rate given within the band, as it is given', () => {
    const decision = decideRecordExpense(facts(offering('0.95')), paid({ rate: '0.931' }), now);
    expect(decision.data?.state.original).toMatchObject({ rate: '0.931' });
  });

  it('refuses a rate given beyond the band, by the name of the rule', () => {
    const decision = decideRecordExpense(facts(offering('0.95')), paid({ rate: '0.93' }), now);
    expect(decision.error).toMatchObject({ type: 'RateOutsideBand' });
  });

  it('refuses a rate left out when no rate is offered, by name', () => {
    expect(decideRecordExpense(facts({ kind: 'none' }), paid(), now).error).toMatchObject({ type: 'NoRateOffered' });
  });

  it('refuses a rate given when no rate is offered to compare it with', () => {
    expect(decideRecordExpense(facts({ kind: 'none' }), paid({ rate: '0.95' }), now).error).toMatchObject({
      type: 'NoRateOffered',
    });
  });

  it('refuses a rate left out when no rates service is configured', () => {
    expect(decideRecordExpense(facts(NO_SERVICE), paid(), now).error).toMatchObject({ type: 'NoRateOffered' });
  });

  it('takes the payer rate, whatever it is, when no rates service is configured (request 21)', () => {
    const decision = decideRecordExpense(facts(NO_SERVICE), paid({ rate: '0.5' }), now);
    expect(decision.data?.state.original).toMatchObject({ rate: '0.5' });
  });

  it('refuses a rate that is not a rate before it looks at the offer', () => {
    expect(decideRecordExpense(facts(offering('0.95')), paid({ rate: '0' }), now).error).toMatchObject({
      type: 'InvalidExpenseRate',
    });
  });

  it('refuses a day that is not a day before it asks the offer for a rate', () => {
    const bad = { ...paid(), date: '2026-02-30' } as RecordExpenseCommand;
    expect(decideRecordExpense(facts({ kind: 'none' }), bad, now).error).toMatchObject({ type: 'InvalidExpenseDate' });
  });
});
