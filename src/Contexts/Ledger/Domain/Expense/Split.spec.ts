import { Split } from '@Contexts/Ledger/Domain/Expense/Split';

describe('Split.of, equally', () => {
  const members = ['ada', 'bob', 'cy', 'dee'];
  const equal = (amount: number, between: string[], payerId: string) =>
    Split.of({ input: { kind: 'equal', between }, amount, payerId, members });

  it('divides the amount by the number of members, the remainder whole to the first member listed', () => {
    const split = equal(1000, ['ada', 'bob', 'cy'], 'ada');

    expect(split.isSuccess()).toBe(true);
    expect(split.data?.kind).toBe('equal');
    expect(split.data?.shares).toEqual([
      { memberId: 'ada', amount: 334 },
      { memberId: 'bob', amount: 333 },
      { memberId: 'cy', amount: 333 },
    ]);
  });

  it('keeps the order the split was given, not the order of the members', () => {
    expect(equal(10, ['cy', 'ada'], 'ada').data?.shares).toEqual([
      { memberId: 'cy', amount: 5 },
      { memberId: 'ada', amount: 5 },
    ]);
  });

  it('gives the first member listed the whole remainder, which is less than the number of members, whoever paid', () => {
    expect(equal(7, ['ada', 'bob', 'cy', 'dee'], 'bob').data?.shares).toEqual([
      { memberId: 'ada', amount: 4 },
      { memberId: 'bob', amount: 1 },
      { memberId: 'cy', amount: 1 },
      { memberId: 'dee', amount: 1 },
    ]);
  });

  it('gives 1000 between three members, the payer listed second, 334 to the first member and 333 to the others', () => {
    expect(equal(1000, ['bob', 'ada', 'cy'], 'ada').data?.shares).toEqual([
      { memberId: 'bob', amount: 334 },
      { memberId: 'ada', amount: 333 },
      { memberId: 'cy', amount: 333 },
    ]);
  });

  it('adds the shares up to the amount, exactly, for any amount and split', () => {
    for (const amount of [1, 2, 99, 100, 1000, 99_999_999, 100_000_000]) {
      for (let count = 1; count <= members.length; count++) {
        const between = members.slice(0, count);
        expect(equal(amount, between, between[count - 1]).data?.total).toBe(amount);
      }
    }
  });

  it('refuses a split a member is listed twice in, one with someone who is not a member, and one without its payer', () => {
    expect(equal(10, ['ada', 'ada'], 'ada').error?.type).toBe('DuplicateInSplit');
    expect(equal(10, ['ada', 'eve'], 'ada').error?.type).toBe('NotAMemberInSplit');
    expect(equal(10, ['bob'], 'ada').error?.type).toBe('PayerNotInSplit');
    expect(equal(10, [], 'ada').error?.type).toBe('PayerNotInSplit');
  });
});

describe('Split.of, by exact amounts', () => {
  const members = ['ada', 'bob', 'cy'];
  const exact = (amount: number, amounts: Array<{ memberId: string; amount: number }>, payerId = 'ada') =>
    Split.of({ input: { kind: 'exact', amounts }, amount, payerId, members });

  it('gives each member the exact amount of their share, in the order given', () => {
    const split = exact(1000, [
      { memberId: 'bob', amount: 700 },
      { memberId: 'ada', amount: 300 },
    ]);

    expect(split.isSuccess()).toBe(true);
    expect(split.data?.kind).toBe('exact');
    expect(split.data?.shares).toEqual([
      { memberId: 'bob', amount: 700 },
      { memberId: 'ada', amount: 300 },
    ]);
  });

  it('accepts a share of 0, and a split whose amounts add up to the amount exactly', () => {
    const split = exact(10, [
      { memberId: 'ada', amount: 0 },
      { memberId: 'bob', amount: 10 },
    ]);

    expect(split.isSuccess()).toBe(true);
    expect(split.data?.total).toBe(10);
  });

  it('refuses amounts that do not add up to the expense, exactly', () => {
    expect(
      exact(10, [
        { memberId: 'ada', amount: 4 },
        { memberId: 'bob', amount: 5 },
      ]).error?.type,
    ).toBe('SplitDoesNotAddUp');
    expect(
      exact(10, [
        { memberId: 'ada', amount: 6 },
        { memberId: 'bob', amount: 5 },
      ]).error?.type,
    ).toBe('SplitDoesNotAddUp');
  });

  it('adds up exactly beyond what a number holds exactly', () => {
    const big = Number.MAX_SAFE_INTEGER;
    const split = Split.of({
      input: {
        kind: 'exact',
        amounts: [
          { memberId: 'ada', amount: big },
          { memberId: 'bob', amount: 1 },
        ],
      },
      amount: big,
      payerId: 'ada',
      members,
    });

    expect(split.error?.type).toBe('SplitDoesNotAddUp');
  });

  it('refuses an amount that is negative or not whole', () => {
    expect(
      exact(10, [
        { memberId: 'ada', amount: -5 },
        { memberId: 'bob', amount: 15 },
      ]).error?.type,
    ).toBe('InvalidSplitAmount');
    expect(
      exact(10, [
        { memberId: 'ada', amount: 2.5 },
        { memberId: 'bob', amount: 7.5 },
      ]).error?.type,
    ).toBe('InvalidSplitAmount');
  });

  it('refuses the same split refusals as an equal split: duplicates, strangers and no payer', () => {
    expect(
      exact(10, [
        { memberId: 'ada', amount: 5 },
        { memberId: 'ada', amount: 5 },
      ]).error?.type,
    ).toBe('DuplicateInSplit');
    expect(
      exact(10, [
        { memberId: 'ada', amount: 5 },
        { memberId: 'eve', amount: 5 },
      ]).error?.type,
    ).toBe('NotAMemberInSplit');
    expect(exact(10, [{ memberId: 'bob', amount: 10 }]).error?.type).toBe('PayerNotInSplit');
  });
});

describe('Split.of, by shares', () => {
  const members = ['ada', 'bob', 'cy'];
  const byShares = (amount: number, shares: Array<{ memberId: string; shares: number }>, payerId = 'ada') =>
    Split.of({ input: { kind: 'shares', shares }, amount, payerId, members });

  it('gives 1000 by shares of 1, 1 and 1 the equal split', () => {
    const split = byShares(1000, [
      { memberId: 'ada', shares: 1 },
      { memberId: 'bob', shares: 1 },
      { memberId: 'cy', shares: 1 },
    ]);

    expect(split.data?.kind).toBe('shares');
    expect(split.data?.shares).toEqual([
      { memberId: 'ada', amount: 334 },
      { memberId: 'bob', amount: 333 },
      { memberId: 'cy', amount: 333 },
    ]);
  });

  it('gives 1001 by shares of 2 and 1, the payer listed second, the remainder to the first member: 668 and 333', () => {
    const split = byShares(
      1001,
      [
        { memberId: 'bob', shares: 2 },
        { memberId: 'ada', shares: 1 },
      ],
      'ada',
    );

    expect(split.data?.shares).toEqual([
      { memberId: 'bob', amount: 668 },
      { memberId: 'ada', amount: 333 },
    ]);
  });

  it('gives the remainder to the first member listed, whichever member paid, and the shares add up to the amount', () => {
    for (const amount of [1, 7, 99, 1000, 99_999_999, 100_000_000]) {
      const split = byShares(
        amount,
        [
          { memberId: 'ada', shares: 3 },
          { memberId: 'bob', shares: 5 },
          { memberId: 'cy', shares: 7 },
        ],
        'cy',
      );
      expect(split.data?.total).toBe(amount);
    }
  });

  it('computes each share exactly, with no rounding of the product', () => {
    const split = byShares(
      100_000_000,
      [
        { memberId: 'ada', shares: 99_999_999 },
        { memberId: 'bob', shares: 1 },
      ],
      'bob',
    );

    expect(split.data?.shares).toEqual([
      { memberId: 'ada', amount: 99_999_999 },
      { memberId: 'bob', amount: 1 },
    ]);
  });

  it('refuses a member with less than 1 share, and a number of shares that is not whole', () => {
    expect(
      byShares(10, [
        { memberId: 'ada', shares: 0 },
        { memberId: 'bob', shares: 1 },
      ]).error?.type,
    ).toBe('InvalidShares');
    expect(
      byShares(10, [
        { memberId: 'ada', shares: 1.5 },
        { memberId: 'bob', shares: 1 },
      ]).error?.type,
    ).toBe('InvalidShares');
  });

  it('refuses the same split refusals as an equal split: duplicates, strangers and no payer', () => {
    expect(
      byShares(10, [
        { memberId: 'ada', shares: 1 },
        { memberId: 'ada', shares: 2 },
      ]).error?.type,
    ).toBe('DuplicateInSplit');
    expect(byShares(10, [{ memberId: 'eve', shares: 1 }]).error?.type).toBe('NotAMemberInSplit');
    expect(byShares(10, [{ memberId: 'bob', shares: 1 }]).error?.type).toBe('PayerNotInSplit');
  });
});

describe('Split.fromSnapshot', () => {
  it('reads the kind and the shares the store kept, in their order', () => {
    const split = Split.fromSnapshot({
      kind: 'shares',
      shares: [
        { memberId: 'bob', amount: 667 },
        { memberId: 'ada', amount: 334 },
      ],
    });

    expect(split.kind).toBe('shares');
    expect(split.shares).toEqual([
      { memberId: 'bob', amount: 667 },
      { memberId: 'ada', amount: 334 },
    ]);
  });
});
