import { suggestTransfers } from '@Contexts/Settlements/Domain/Suggestion/SuggestedTransfers';

describe('suggestTransfers', () => {
  it('is the example of request 11: the most owing pays the most owed, ties to whoever joined first', () => {
    // Ann is owed 500, Bob 100; Cy and Dan owe 300 each, Cy having joined first.
    expect(
      suggestTransfers([
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

  it('suggests nothing when every balance is already 0', () => {
    expect(
      suggestTransfers([
        { memberId: 'ann', balance: 0 },
        { memberId: 'bob', balance: 0 },
      ]),
    ).toEqual([]);
    expect(suggestTransfers([])).toEqual([]);
  });

  it('takes the first to join of two owing the same, and of two owed the same', () => {
    // Bob and Cy both owe 200, and Ann and Dan are both owed 200: of each pair the one who joined first is taken, so Bob pays
    // Ann, and then Cy pays Dan.
    expect(
      suggestTransfers([
        { memberId: 'ann', balance: 200 },
        { memberId: 'bob', balance: -200 },
        { memberId: 'cy', balance: -200 },
        { memberId: 'dan', balance: 200 },
      ]),
    ).toEqual([
      { from: 'bob', to: 'ann', amount: 200 },
      { from: 'cy', to: 'dan', amount: 200 },
    ]);
  });

  it('never makes more transfers than the members not at 0 less one, and leaves every balance at 0', () => {
    const members = [
      { memberId: 'a', balance: 700 },
      { memberId: 'b', balance: -120 },
      { memberId: 'c', balance: 0 },
      { memberId: 'd', balance: -380 },
      { memberId: 'e', balance: -200 },
    ];
    const transfers = suggestTransfers(members);
    expect(transfers.length).toBeLessThanOrEqual(4);
    const after = new Map(members.map(({ memberId, balance }) => [memberId, balance]));
    for (const { from, to, amount } of transfers) {
      expect(amount).toBeGreaterThan(0);
      after.set(from, (after.get(from) ?? 0) + amount);
      after.set(to, (after.get(to) ?? 0) - amount);
    }
    expect([...after.values()].every(balance => balance === 0)).toBe(true);
  });

  it('stops rather than loops when the balances do not add up to 0', () => {
    expect(
      suggestTransfers([
        { memberId: 'ann', balance: -100 },
        { memberId: 'bob', balance: -50 },
      ]),
    ).toEqual([]);
  });
});
