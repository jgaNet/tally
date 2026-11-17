import { Split } from '@Contexts/Ledger/Domain/Expense/Split';

describe('Split.equally', () => {
  const members = ['ada', 'bob', 'cy', 'dee'];

  it('divides the amount by the number of members, the remainder whole to the payer', () => {
    const split = Split.equally({ amount: 1000, between: ['ada', 'bob', 'cy'], payerId: 'ada', members });

    expect(split.isSuccess()).toBe(true);
    expect(split.data?.shares).toEqual([
      { memberId: 'ada', amount: 334 },
      { memberId: 'bob', amount: 333 },
      { memberId: 'cy', amount: 333 },
    ]);
  });

  it('keeps the order the split was given, not the order of the members', () => {
    const split = Split.equally({ amount: 10, between: ['cy', 'ada'], payerId: 'ada', members });

    expect(split.data?.shares).toEqual([
      { memberId: 'cy', amount: 5 },
      { memberId: 'ada', amount: 5 },
    ]);
  });

  it('gives the payer the whole remainder, which is less than the number of members', () => {
    const split = Split.equally({ amount: 7, between: ['ada', 'bob', 'cy', 'dee'], payerId: 'bob', members });

    expect(split.data?.shares).toEqual([
      { memberId: 'ada', amount: 1 },
      { memberId: 'bob', amount: 4 },
      { memberId: 'cy', amount: 1 },
      { memberId: 'dee', amount: 1 },
    ]);
  });

  it('adds the shares up to the amount, exactly, for any amount and split', () => {
    for (const amount of [1, 2, 99, 100, 1000, 99_999_999, 100_000_000]) {
      for (let count = 1; count <= members.length; count++) {
        const between = members.slice(0, count);
        const split = Split.equally({ amount, between, payerId: between[count - 1], members });
        expect(split.data?.total).toBe(amount);
      }
    }
  });

  it('refuses a split a member is listed twice in', () => {
    const split = Split.equally({ amount: 10, between: ['ada', 'ada'], payerId: 'ada', members });

    expect(split.isFailure()).toBe(true);
    expect(split.error?.type).toBe('DuplicateInSplit');
  });

  it('refuses a split with someone who is not a current member', () => {
    const split = Split.equally({ amount: 10, between: ['ada', 'eve'], payerId: 'ada', members });

    expect(split.error?.type).toBe('NotAMemberInSplit');
  });

  it('refuses a split without its payer, the empty one included', () => {
    expect(Split.equally({ amount: 10, between: ['bob'], payerId: 'ada', members }).error?.type).toBe(
      'PayerNotInSplit',
    );
    expect(Split.equally({ amount: 10, between: [], payerId: 'ada', members }).error?.type).toBe('PayerNotInSplit');
  });
});
