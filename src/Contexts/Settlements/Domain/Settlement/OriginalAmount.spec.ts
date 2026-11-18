import { describe, expect, it } from '@jest/globals';

import { OriginalAmount } from '@Contexts/Settlements/Domain/Settlement/OriginalAmount';
import {
  InvalidOriginalAmountException,
  InvalidOriginalCurrencyException,
  NoRateOfferedException,
  OriginalCurrencyIsGroupCurrencyException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';

describe('a settlement in another currency, converted at the rate offered (request 39)', () => {
  it('keeps the currency, the amount and the rate offered, and converts the amount to the group’s, half up', () => {
    const decided = OriginalAmount.decide({ currency: 'CHF', amount: 1234, offered: '1.0625' }, 'EUR');
    expect(decided.data?.toRecord()).toEqual({ currency: 'CHF', amount: 1234, rate: '1.0625' });
    expect(decided.data?.toGroupAmount()).toBe(1311);
  });

  it('rounds a half up, as an expense does (request 21)', () => {
    expect(
      OriginalAmount.decide({ currency: 'USD', amount: 1000, offered: '0.9545' }, 'EUR').data?.toGroupAmount(),
    ).toBe(955);
    expect(OriginalAmount.decide({ currency: 'USD', amount: 3, offered: '0.5' }, 'EUR').data?.toGroupAmount()).toBe(2);
    expect(OriginalAmount.decide({ currency: 'USD', amount: 1, offered: '0.5' }, 'EUR').data?.toGroupAmount()).toBe(1);
  });

  it('converts a fee in the same currency at the same rate', () => {
    const decided = OriginalAmount.decide({ currency: 'CHF', amount: 5000, offered: '1.0625' }, 'EUR').data!;
    expect(decided.groupAmountOf(50)).toBe(53);
    expect(decided.groupAmountOf(0)).toBe(0);
  });

  it('reads back as the record it was decided as', () => {
    const decided = OriginalAmount.decide({ currency: 'GBP', amount: 700, offered: '1.150000' }, 'EUR').data!;
    const kept = OriginalAmount.kept(decided.toRecord());
    expect(kept.toRecord()).toEqual({ currency: 'GBP', amount: 700, rate: '1.150000' });
    expect(kept.toGroupAmount()).toBe(805);
  });

  it('refuses, by name, a currency that is not Tally’s, the group’s own, an amount out of range, and no rate offered', () => {
    expect(OriginalAmount.decide({ currency: 'JPY', amount: 1, offered: '1' }, 'EUR').error).toBeInstanceOf(
      InvalidOriginalCurrencyException,
    );
    expect(OriginalAmount.decide({ currency: 'EUR', amount: 1, offered: '1' }, 'EUR').error).toBeInstanceOf(
      OriginalCurrencyIsGroupCurrencyException,
    );
    for (const amount of [0, -1, 1.5, 100_000_001]) {
      expect(OriginalAmount.decide({ currency: 'CHF', amount, offered: '1' }, 'EUR').error).toBeInstanceOf(
        InvalidOriginalAmountException,
      );
    }
    for (const offered of [undefined, '0', '0.000', '1e3', '-1', '1.0000001']) {
      expect(OriginalAmount.decide({ currency: 'CHF', amount: 1, offered }, 'EUR').error).toBeInstanceOf(
        NoRateOfferedException,
      );
    }
  });
});
