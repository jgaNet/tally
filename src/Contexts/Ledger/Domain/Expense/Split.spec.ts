import { ExpenseAmount } from './ExpenseAmount';
import { Split, SplitRequest } from './Split';

const ada = 'ada';
const grace = 'grace';
const linus = 'linus';

/** An amount, validated the way an expense validates it. */
const amountOf = (value: number): ExpenseAmount => ExpenseAmount.create(value).data!;

/** A split of `value` as `request`, paid by `payer`, which must be a success. */
const splitOf = (value: number, request: SplitRequest, payer = ada): Split => {
  const split = Split.create({ amount: amountOf(value), request, payer });
  if (split.isFailure()) throw new Error(`the split was refused: ${split.error?.type}`);
  return split.data!;
};

const refusedWith = (value: number, request: SplitRequest, payer = ada) =>
  Split.create({ amount: amountOf(value), request, payer }).error;

describe('a split by exact amounts (request 7)', () => {
  it('gives each member the amount they were given, in the order given, and says it is exact', () => {
    const split = splitOf(1000, {
      kind: 'exact',
      amounts: [
        { memberId: grace, amount: 700 },
        { memberId: ada, amount: 300 },
      ],
    });
    expect(split.kind).toBe('exact');
    expect(split.shares).toEqual([
      { memberId: grace, amount: 700 },
      { memberId: ada, amount: 300 },
    ]);
  });

  it('allows a member to owe nothing, but refuses amounts that are negative, not whole, or not adding up to the amount', () => {
    expect(
      splitOf(100, {
        kind: 'exact',
        amounts: [
          { memberId: ada, amount: 100 },
          { memberId: grace, amount: 0 },
        ],
      }).shares[1].amount,
    ).toBe(0);
    expect(
      refusedWith(100, {
        kind: 'exact',
        amounts: [
          { memberId: ada, amount: 150 },
          { memberId: grace, amount: -50 },
        ],
      }),
    ).toMatchObject({ type: 'InvalidSplitAmount' });
    expect(
      refusedWith(100, {
        kind: 'exact',
        amounts: [
          { memberId: ada, amount: 50.5 },
          { memberId: grace, amount: 49.5 },
        ],
      }),
    ).toMatchObject({ type: 'InvalidSplitAmount' });
    expect(
      refusedWith(100, {
        kind: 'exact',
        amounts: [
          { memberId: ada, amount: 60 },
          { memberId: grace, amount: 39 },
        ],
      }),
    ).toMatchObject({ type: 'SplitAmountsDoNotAddUp' });
  });

  it('keeps the payer among the members and each listed once, as every split does', () => {
    expect(refusedWith(10, { kind: 'exact', amounts: [{ memberId: grace, amount: 10 }] })).toMatchObject({
      type: 'PayerNotInSplit',
    });
    expect(
      refusedWith(10, {
        kind: 'exact',
        amounts: [
          { memberId: ada, amount: 5 },
          { memberId: ada, amount: 5 },
        ],
      }),
    ).toMatchObject({ type: 'SplitMemberListedTwice' });
  });
});

describe('a split by shares (request 7)', () => {
  it('gives each member the amount times their shares over the total of the shares, rounded down, the remainder to the first member listed', () => {
    // 1001 by shares of 2 and 1, the payer (ada, 1 share) listed second: 667 + 333 = 1000, the remainder 1 goes to grace,
    // the member listed first, whoever paid (request 10).
    const split = splitOf(1001, {
      kind: 'shares',
      shares: [
        { memberId: grace, shares: 2 },
        { memberId: ada, shares: 1 },
      ],
    });
    expect(split.kind).toBe('shares');
    expect(split.shares).toEqual([
      { memberId: grace, amount: 668 },
      { memberId: ada, amount: 333 },
    ]);
  });

  it('is the equal split when every member has one share', () => {
    const shares = splitOf(1000, {
      kind: 'shares',
      shares: [
        { memberId: ada, shares: 1 },
        { memberId: grace, shares: 1 },
        { memberId: linus, shares: 1 },
      ],
    });
    const equal = splitOf(1000, { kind: 'equal', memberIds: [ada, grace, linus] });
    expect(shares.shares).toEqual(equal.shares);
    expect(shares.shares).toEqual([
      { memberId: ada, amount: 334 },
      { memberId: grace, amount: 333 },
      { memberId: linus, amount: 333 },
    ]);
  });

  it('adds up to the amount exactly, whatever the shares, even of a very large number', () => {
    const split = splitOf(100_000_000, {
      kind: 'shares',
      shares: [
        { memberId: grace, shares: 1 },
        { memberId: ada, shares: Number.MAX_SAFE_INTEGER },
      ],
    });
    expect(split.shares.reduce((sum, share) => sum + share.amount, 0)).toBe(100_000_000);
  });

  it('refuses a member with fewer than one share, or a share that is not whole', () => {
    expect(
      refusedWith(10, {
        kind: 'shares',
        shares: [
          { memberId: ada, shares: 0 },
          { memberId: grace, shares: 2 },
        ],
      }),
    ).toMatchObject({ type: 'InvalidSplitShares' });
    expect(
      refusedWith(10, {
        kind: 'shares',
        shares: [
          { memberId: ada, shares: 1.5 },
          { memberId: grace, shares: 2 },
        ],
      }),
    ).toMatchObject({ type: 'InvalidSplitShares' });
  });
});

describe('the remainder goes to the first member listed (request 10)', () => {
  it("gives the equal split's remainder to the first member listed, whoever paid", () => {
    // 1000 among three, the payer (grace) listed second: the first member gets 334; the payer and the third get 333.
    const split = splitOf(1000, { kind: 'equal', memberIds: [ada, grace, linus] }, grace);
    expect(split.shares).toEqual([
      { memberId: ada, amount: 334 },
      { memberId: grace, amount: 333 },
      { memberId: linus, amount: 333 },
    ]);
  });

  it('leaves the split by exact amounts unchanged: it has no remainder', () => {
    const split = splitOf(
      1000,
      {
        kind: 'exact',
        amounts: [
          { memberId: grace, amount: 333 },
          { memberId: ada, amount: 333 },
          { memberId: linus, amount: 334 },
        ],
      },
      ada,
    );
    expect(split.shares.map(share => share.amount)).toEqual([333, 333, 334]);
  });
});

describe('restoring a stored split', () => {
  it('restores an equal split made under the old rule, the remainder to the payer, without computing it again', () => {
    // Recorded before request 10: 1000 among ada (first), grace (payer) and linus: the payer has the 334.
    const stored = [
      { memberId: ada, amount: 333 },
      { memberId: grace, amount: 334 },
      { memberId: linus, amount: 333 },
    ];
    expect(Split.restore({ amount: 1000, payer: grace, kind: 'equal', shares: stored })?.shares).toEqual(stored);
    // And one made under the new rule, the remainder to the first member listed:
    const current = [
      { memberId: ada, amount: 334 },
      { memberId: grace, amount: 333 },
      { memberId: linus, amount: 333 },
    ];
    expect(Split.restore({ amount: 1000, payer: grace, kind: 'equal', shares: current })?.shares).toEqual(current);
    // An equal split whose remainder sits with neither is refused.
    expect(
      Split.restore({
        amount: 1000,
        payer: grace,
        kind: 'equal',
        shares: [
          { memberId: ada, amount: 333 },
          { memberId: grace, amount: 333 },
          { memberId: linus, amount: 334 },
        ],
      }),
    ).toBeUndefined();
  });

  it('restores each kind as it was made, and refuses amounts no split of that kind could have given', () => {
    const shares = [
      { memberId: grace, amount: 667 },
      { memberId: ada, amount: 334 },
    ];
    expect(Split.restore({ amount: 1001, payer: ada, kind: 'shares', shares })?.kind).toBe('shares');
    expect(Split.restore({ amount: 1001, payer: ada, kind: 'exact', shares })?.kind).toBe('exact');
    expect(Split.restore({ amount: 1001, payer: ada, kind: 'equal', shares })).toBeUndefined();
    expect(
      Split.restore({
        amount: 1000,
        payer: ada,
        kind: 'shares',
        shares,
      }),
    ).toBeUndefined();
  });
});
