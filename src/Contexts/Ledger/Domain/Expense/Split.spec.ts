import { describe, expect, it } from '@jest/globals';

import { Split } from '@Contexts/Ledger/Domain/Expense/Split';

describe('Split.decide, equally', () => {
  it('divides the amount equally, the remainder whole to the payer, and the shares add up to the amount', () => {
    const split = Split.decide({
      amount: 1000,
      payerId: 'ann',
      split: { kind: 'equal', memberIds: ['ann', 'bob', 'carol'] },
    });
    expect(split.data?.kind).toBe('equal');
    expect(split.data?.shares).toEqual([
      { memberId: 'ann', amount: 334 },
      { memberId: 'bob', amount: 333 },
      { memberId: 'carol', amount: 333 },
    ]);
  });

  it('gives the remainder to a payer who is not first, and keeps the order given', () => {
    const split = Split.decide({
      amount: 10,
      payerId: 'bob',
      split: { kind: 'equal', memberIds: ['carol', 'bob', 'ann'] },
    });
    expect(split.data?.shares).toEqual([
      { memberId: 'carol', amount: 3 },
      { memberId: 'bob', amount: 4 },
      { memberId: 'ann', amount: 3 },
    ]);
  });

  it('refuses a member listed twice, and a split without its payer', () => {
    expect(
      Split.decide({ amount: 10, payerId: 'ann', split: { kind: 'equal', memberIds: ['ann', 'ann'] } }).error?.type,
    ).toBe('DuplicateSplitMember');
    expect(Split.decide({ amount: 10, payerId: 'ann', split: { kind: 'equal', memberIds: ['bob'] } }).error?.type).toBe(
      'PayerNotInSplit',
    );
  });
});

describe('Split.decide, by exact amounts', () => {
  it('keeps each amount as given, in the order given, when they add up to the amount exactly', () => {
    const split = Split.decide({
      amount: 1000,
      payerId: 'ann',
      split: {
        kind: 'exact',
        amounts: [
          { memberId: 'bob', amount: 600 },
          { memberId: 'ann', amount: 300 },
          { memberId: 'carol', amount: 100 },
        ],
      },
    });
    expect(split.data?.kind).toBe('exact');
    expect(split.data?.shares).toEqual([
      { memberId: 'bob', amount: 600 },
      { memberId: 'ann', amount: 300 },
      { memberId: 'carol', amount: 100 },
    ]);
  });

  it('accepts an amount of 0 for a member', () => {
    const split = Split.decide({
      amount: 500,
      payerId: 'ann',
      split: {
        kind: 'exact',
        amounts: [
          { memberId: 'ann', amount: 0 },
          { memberId: 'bob', amount: 500 },
        ],
      },
    });
    expect(split.isFailure()).toBe(false);
  });

  it('refuses amounts that do not add up to the amount, exactly, by SplitAmountsDoNotAddUp', () => {
    const split = Split.decide({
      amount: 1000,
      payerId: 'ann',
      split: {
        kind: 'exact',
        amounts: [
          { memberId: 'ann', amount: 600 },
          { memberId: 'bob', amount: 399 },
        ],
      },
    });
    expect(split.error?.type).toBe('SplitAmountsDoNotAddUp');
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 2])('refuses the amount %s by InvalidSplitAmount', amount => {
    const split = Split.decide({
      amount: 1000,
      payerId: 'ann',
      split: {
        kind: 'exact',
        amounts: [
          { memberId: 'ann', amount: 1000 },
          { memberId: 'bob', amount },
        ],
      },
    });
    expect(split.error?.type).toBe('InvalidSplitAmount');
  });

  it('refuses a member listed twice, and a split without its payer, before the amounts are looked at', () => {
    expect(
      Split.decide({
        amount: 10,
        payerId: 'ann',
        split: {
          kind: 'exact',
          amounts: [
            { memberId: 'ann', amount: 5 },
            { memberId: 'ann', amount: 5 },
          ],
        },
      }).error?.type,
    ).toBe('DuplicateSplitMember');
    expect(
      Split.decide({ amount: 10, payerId: 'ann', split: { kind: 'exact', amounts: [{ memberId: 'bob', amount: 10 }] } })
        .error?.type,
    ).toBe('PayerNotInSplit');
  });
});

describe('Split.decide, by shares', () => {
  it('is the equal split of request 4 when every member has 1 share', () => {
    const byShares = Split.decide({
      amount: 1000,
      payerId: 'ann',
      split: {
        kind: 'shares',
        shares: [
          { memberId: 'ann', shares: 1 },
          { memberId: 'bob', shares: 1 },
          { memberId: 'carol', shares: 1 },
        ],
      },
    });
    const equal = Split.decide({
      amount: 1000,
      payerId: 'ann',
      split: { kind: 'equal', memberIds: ['ann', 'bob', 'carol'] },
    });
    expect(byShares.data?.shares).toEqual(equal.data?.shares);
    expect(byShares.data?.kind).toBe('shares');
  });

  it('divides 1001 by 2 and 1 shares, the payer listed second: 667 and 334, the remainder to the payer', () => {
    const split = Split.decide({
      amount: 1001,
      payerId: 'bob',
      split: {
        kind: 'shares',
        shares: [
          { memberId: 'ann', shares: 2 },
          { memberId: 'bob', shares: 1 },
        ],
      },
    });
    expect(split.data?.shares).toEqual([
      { memberId: 'ann', amount: 667 },
      { memberId: 'bob', amount: 334 },
    ]);
  });

  it('divides exactly with large amounts and shares, where floating point would not', () => {
    const split = Split.decide({
      amount: 100_000_000,
      payerId: 'ann',
      split: {
        kind: 'shares',
        shares: [
          { memberId: 'ann', shares: 3 },
          { memberId: 'bob', shares: 7 },
        ],
      },
    });
    expect(split.data?.shares).toEqual([
      { memberId: 'ann', amount: 30_000_000 },
      { memberId: 'bob', amount: 70_000_000 },
    ]);
  });

  it('always adds up to the amount, whatever the shares', () => {
    const split = Split.decide({
      amount: 100,
      payerId: 'carol',
      split: {
        kind: 'shares',
        shares: [
          { memberId: 'ann', shares: 1 },
          { memberId: 'bob', shares: 1 },
          { memberId: 'carol', shares: 1 },
          { memberId: 'dana', shares: 2 },
        ],
      },
    });
    expect(split.data?.shares.reduce((sum, share) => sum + share.amount, 0)).toBe(100);
  });

  it.each([0, -2, 1.5])('refuses the shares %s by InvalidSplitShares: a member has at least 1 whole share', shares => {
    const split = Split.decide({
      amount: 100,
      payerId: 'ann',
      split: {
        kind: 'shares',
        shares: [
          { memberId: 'ann', shares: 1 },
          { memberId: 'bob', shares },
        ],
      },
    });
    expect(split.error?.type).toBe('InvalidSplitShares');
  });
});

describe('Split.kept', () => {
  it('keeps the kind and the shares as they were decided, and records nothing', () => {
    const split = Split.kept({
      kind: 'shares',
      amount: 1001,
      payerId: 'bob',
      shares: [
        { memberId: 'ann', amount: 667 },
        { memberId: 'bob', amount: 334 },
      ],
    });
    expect(split.kind).toBe('shares');
    expect(split.shares).toEqual([
      { memberId: 'ann', amount: 667 },
      { memberId: 'bob', amount: 334 },
    ]);
  });

  it('throws on a kind the domain never keeps, and on shares that do not add up to the amount', () => {
    expect(() =>
      Split.kept({ kind: 'other' as never, amount: 10, payerId: 'ann', shares: [{ memberId: 'ann', amount: 10 }] }),
    ).toThrow();
    expect(() =>
      Split.kept({ kind: 'exact', amount: 10, payerId: 'ann', shares: [{ memberId: 'ann', amount: 9 }] }),
    ).toThrow();
  });

  it('is equal to another split only when the kind and the shares are', () => {
    const exact = Split.kept({ kind: 'exact', amount: 10, payerId: 'ann', shares: [{ memberId: 'ann', amount: 10 }] });
    const shares = Split.kept({
      kind: 'shares',
      amount: 10,
      payerId: 'ann',
      shares: [{ memberId: 'ann', amount: 10 }],
    });
    expect(exact.equals(shares)).toBe(false);
    expect(
      exact.equals(
        Split.kept({ kind: 'exact', amount: 10, payerId: 'ann', shares: [{ memberId: 'ann', amount: 10 }] }),
      ),
    ).toBe(true);
  });
});
