import { insightsOf } from '@Contexts/Ledger/Application/Queries/GetMyInsights/insights';

describe("the lines of a person's insights (request 37)", () => {
  it('sums the shares of the groups in one currency, and lists the lines in the stated order', () => {
    const lines = insightsOf(
      [
        { groupId: 'flat', month: '2026-04', category: 'groceries', amount: 3500 },
        { groupId: 'trip', month: '2026-04', category: 'travel', amount: 25000 },
        { groupId: 'flat', month: '2026-03', category: 'groceries', amount: 4000 },
        { groupId: 'house', month: '2026-04', category: 'groceries', amount: 500 },
        { groupId: 'flat', month: '2026-04', category: 'rent', amount: 1000 },
      ],
      new Map([
        ['flat', 'EUR'],
        ['house', 'EUR'],
        ['trip', 'CHF'],
      ]),
    );
    expect(lines).toEqual([
      { month: '2026-03', currency: 'EUR', category: 'groceries', amount: 4000 },
      { month: '2026-04', currency: 'CHF', category: 'travel', amount: 25000 },
      { month: '2026-04', currency: 'EUR', category: 'groceries', amount: 4000 },
      { month: '2026-04', currency: 'EUR', category: 'rent', amount: 1000 },
    ]);
  });

  it('lists a category in the order request 24 gives, and leaves out what adds up to nothing or has no currency', () => {
    const lines = insightsOf(
      [
        { groupId: 'flat', month: '2026-05', category: 'other', amount: 100 },
        { groupId: 'flat', month: '2026-05', category: 'rent', amount: 0 },
        { groupId: 'flat', month: '2026-05', category: 'food', amount: 200 },
        { groupId: 'flat', month: '2026-05', category: 'groceries', amount: 300 },
        { groupId: 'gone', month: '2026-05', category: 'groceries', amount: 999 },
      ],
      new Map([['flat', 'USD']]),
    );
    expect(lines.map(line => line.category)).toEqual(['groceries', 'food', 'other']);
    expect(lines.every(line => line.amount > 0)).toBe(true);
  });

  it('reads nothing when there are no shares', () => {
    expect(insightsOf([], new Map([['flat', 'EUR']]))).toEqual([]);
  });
});
