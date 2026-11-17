import { suggestTransfers } from './SuggestedTransfers';

describe('suggestTransfers', () => {
  it('makes the transfers of the stated example, the most owing paying the most owed first', () => {
    const transfers = suggestTransfers([
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

  it('makes no transfer when every balance is already 0', () => {
    expect(
      suggestTransfers([
        { memberId: 'ann', balance: 0 },
        { memberId: 'bob', balance: 0 },
      ]),
    ).toEqual([]);
  });

  it('makes no transfer for no members at all', () => {
    expect(suggestTransfers([])).toEqual([]);
  });

  it('settles two members with one transfer of the amount they are apart', () => {
    expect(
      suggestTransfers([
        { memberId: 'ann', balance: 40 },
        { memberId: 'bob', balance: -40 },
      ]),
    ).toEqual([{ from: 'bob', to: 'ann', amount: 40 }]);
  });

  it('breaks a tie among those who owe by who joined first', () => {
    const transfers = suggestTransfers([
      { memberId: 'ann', balance: 100 },
      { memberId: 'bob', balance: -50 },
      { memberId: 'cy', balance: -50 },
    ]);
    expect(transfers).toEqual([
      { from: 'bob', to: 'ann', amount: 50 },
      { from: 'cy', to: 'ann', amount: 50 },
    ]);
  });

  it('breaks a tie among those who are owed by who joined first', () => {
    const transfers = suggestTransfers([
      { memberId: 'ann', balance: -100 },
      { memberId: 'bob', balance: 50 },
      { memberId: 'cy', balance: 50 },
    ]);
    expect(transfers).toEqual([
      { from: 'ann', to: 'bob', amount: 50 },
      { from: 'ann', to: 'cy', amount: 50 },
    ]);
  });

  it('never makes more transfers than one fewer than the members whose balance is not 0', () => {
    const members = [
      { memberId: 'a', balance: 7 },
      { memberId: 'b', balance: 3 },
      { memberId: 'c', balance: -2 },
      { memberId: 'd', balance: -4 },
      { memberId: 'e', balance: 0 },
      { memberId: 'f', balance: -4 },
    ];
    const transfers = suggestTransfers(members);
    const notZero = members.filter(member => member.balance !== 0).length;
    expect(transfers.length).toBeLessThanOrEqual(notZero - 1);
  });

  it('leaves every balance at 0 once the transfers are made', () => {
    const members = [
      { memberId: 'a', balance: 12 },
      { memberId: 'b', balance: -5 },
      { memberId: 'c', balance: -7 },
      { memberId: 'd', balance: 4 },
      { memberId: 'e', balance: -4 },
    ];
    const left = new Map(members.map(member => [member.memberId, member.balance]));
    for (const { from, to, amount } of suggestTransfers(members)) {
      expect(amount).toBeGreaterThanOrEqual(1);
      left.set(from, left.get(from)! + amount);
      left.set(to, left.get(to)! - amount);
    }
    expect([...left.values()].every(balance => balance === 0)).toBe(true);
  });

  it('refuses balances that do not add up to 0, as corrupted state', () => {
    expect(() => suggestTransfers([{ memberId: 'ann', balance: 5 }])).toThrow();
  });
});
