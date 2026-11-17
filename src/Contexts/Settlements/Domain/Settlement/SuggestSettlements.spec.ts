import { suggestSettlements } from '@Contexts/Settlements/Domain/Settlement/SuggestSettlements';

describe('suggestSettlements', () => {
  it('pays the most owing to the most owed, in the order the transfers are made, as the request states', () => {
    // Ann is owed 500, Bob 100; Cy owes 300 and Dan owes 300, Cy having joined first.
    expect(
      suggestSettlements([
        { memberId: 'ann', balance: 500 },
        { memberId: 'bob', balance: 100 },
        { memberId: 'cy', balance: -300 },
        { memberId: 'dan', balance: -300 },
      ]),
    ).toEqual([
      { from: 'cy', to: 'ann', amount: 300 },
      { from: 'dan', to: 'ann', amount: 200 },
      { from: 'dan', to: 'bob', amount: 100 },
    ]);
  });

  it('takes the member who joined first on a tie, among those who owe and among those who are owed', () => {
    // Bob and Cy both owe 100, Bob joined first; Ann and Dan are both owed 100, Ann joined first.
    expect(
      suggestSettlements([
        { memberId: 'ann', balance: 100 },
        { memberId: 'bob', balance: -100 },
        { memberId: 'cy', balance: -100 },
        { memberId: 'dan', balance: 100 },
      ]),
    ).toEqual([
      { from: 'bob', to: 'ann', amount: 100 },
      { from: 'cy', to: 'dan', amount: 100 },
    ]);
  });

  it('gives no transfer when every balance is already 0', () => {
    expect(
      suggestSettlements([
        { memberId: 'ann', balance: 0 },
        { memberId: 'bob', balance: 0 },
      ]),
    ).toEqual([]);
    expect(suggestSettlements([])).toEqual([]);
  });

  it('makes one fewer transfer than the members who are not even, and each balance ends at 0', () => {
    const balances = [
      { memberId: 'a', balance: 700 },
      { memberId: 'b', balance: -250 },
      { memberId: 'c', balance: 0 },
      { memberId: 'd', balance: -450 },
      { memberId: 'e', balance: 0 },
    ];
    const transfers = suggestSettlements(balances);

    expect(transfers.length).toBe(2);
    expect(transfers.every(transfer => transfer.amount >= 1)).toBe(true);
    const after = new Map(balances.map(member => [member.memberId, member.balance]));
    for (const transfer of transfers) {
      after.set(transfer.from, (after.get(transfer.from) ?? 0) + transfer.amount);
      after.set(transfer.to, (after.get(transfer.to) ?? 0) - transfer.amount);
    }
    expect([...after.values()].every(balance => balance === 0)).toBe(true);
  });

  it('refuses balances that do not add up to 0, which is corrupted state', () => {
    expect(() => suggestSettlements([{ memberId: 'ann', balance: 100 }])).toThrow();
  });
});
