import { suggestedSettlements } from '@Contexts/Settlements/Domain/Settlement/SuggestedSettlements';

describe('suggestedSettlements (request 11)', () => {
  it('makes the transfers of the stated example, in the order made', () => {
    // Ann, Bob, Cy, Dan joined in that order: Ann is owed 500, Bob 100, Cy and Dan owe 300 each.
    const transfers = suggestedSettlements([
      { memberId: 'ann', balance: 500 },
      { memberId: 'bob', balance: 100 },
      { memberId: 'cy', balance: -300 },
      { memberId: 'dan', balance: -300 },
    ]);

    expect(transfers).toEqual([
      { from: 'cy', to: 'ann', amount: 300 },
      { from: 'dan', to: 'ann', amount: 200 },
      { from: 'dan', to: 'bob', amount: 100 },
    ]);
  });

  it('gives no transfer when every balance is already 0', () => {
    expect(
      suggestedSettlements([
        { memberId: 'ann', balance: 0 },
        { memberId: 'bob', balance: 0 },
      ]),
    ).toEqual([]);
    expect(suggestedSettlements([])).toEqual([]);
  });

  it('breaks a tie among those who owe, and among those who are owed, by the order they joined', () => {
    // Bob and Cy both owe 200; Dan and Eve are both owed 200. Bob (joined first) pays Dan; then Cy pays Eve.
    const transfers = suggestedSettlements([
      { memberId: 'ann', balance: 0 },
      { memberId: 'bob', balance: -200 },
      { memberId: 'cy', balance: -200 },
      { memberId: 'dan', balance: 200 },
      { memberId: 'eve', balance: 200 },
    ]);

    expect(transfers).toEqual([
      { from: 'bob', to: 'dan', amount: 200 },
      { from: 'cy', to: 'eve', amount: 200 },
    ]);
  });

  it('never makes more transfers than one fewer than the members whose balance is not 0, and settles every balance', () => {
    const members = [
      { memberId: 'a', balance: 700 },
      { memberId: 'b', balance: -120 },
      { memberId: 'c', balance: 0 },
      { memberId: 'd', balance: -380 },
      { memberId: 'e', balance: -200 },
    ];
    const transfers = suggestedSettlements(members);

    const notZero = members.filter(({ balance }) => balance !== 0).length;
    expect(transfers.length).toBeLessThanOrEqual(notZero - 1);
    expect(transfers.every(({ amount }) => Number.isInteger(amount) && amount >= 1)).toBe(true);

    const after = new Map(members.map(({ memberId, balance }) => [memberId, balance]));
    for (const { from, to, amount } of transfers) {
      after.set(from, (after.get(from) ?? 0) + amount);
      after.set(to, (after.get(to) ?? 0) - amount);
    }
    for (const balance of after.values()) expect(balance).toBe(0);
  });
});
