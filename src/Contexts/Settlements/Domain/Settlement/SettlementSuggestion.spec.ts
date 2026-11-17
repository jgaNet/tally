import { suggestSettlements } from '@Contexts/Settlements/Domain/Settlement/SettlementSuggestion';

describe('suggestSettlements', () => {
  it('makes the transfers of the stated example: the most owing pays the most owed, ties to whoever joined first', () => {
    // Ann 500, Bob 100, Cy -300, Dan -300, in the order they joined.
    const transfers = suggestSettlements([
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
      suggestSettlements([
        { memberId: 'ann', balance: 0 },
        { memberId: 'bob', balance: 0 },
      ]),
    ).toEqual([]);
    expect(suggestSettlements([])).toEqual([]);
  });

  it('pays a member who is owed the most before one owed less, and the earliest joiner first on a tie of creditors', () => {
    const transfers = suggestSettlements([
      { memberId: 'ann', balance: 200 },
      { memberId: 'bob', balance: 200 },
      { memberId: 'cy', balance: -400 },
    ]);
    expect(transfers).toEqual([
      { from: 'cy', to: 'ann', amount: 200 },
      { from: 'cy', to: 'bob', amount: 200 },
    ]);
  });

  it('takes the earliest joiner as the debtor when two owe the same', () => {
    const transfers = suggestSettlements([
      { memberId: 'ann', balance: -100 },
      { memberId: 'bob', balance: 200 },
      { memberId: 'cy', balance: -100 },
    ]);
    expect(transfers).toEqual([
      { from: 'ann', to: 'bob', amount: 100 },
      { from: 'cy', to: 'bob', amount: 100 },
    ]);
  });

  it('never makes more transfers than one fewer than the members whose balance is not 0, and each amount is at least 1', () => {
    const members = [
      { memberId: 'a', balance: 70 },
      { memberId: 'b', balance: -10 },
      { memberId: 'c', balance: 0 },
      { memberId: 'd', balance: -40 },
      { memberId: 'e', balance: -20 },
    ];
    const transfers = suggestSettlements(members);
    const notZero = members.filter(member => member.balance !== 0).length;
    expect(transfers.length).toBeLessThanOrEqual(notZero - 1);
    expect(transfers.every(transfer => Number.isInteger(transfer.amount) && transfer.amount >= 1)).toBe(true);
  });

  it('brings every balance to 0 with the transfers it makes', () => {
    const members = [
      { memberId: 'a', balance: 70 },
      { memberId: 'b', balance: -10 },
      { memberId: 'c', balance: 0 },
      { memberId: 'd', balance: -40 },
      { memberId: 'e', balance: -20 },
    ];
    const after = new Map(members.map(member => [member.memberId, member.balance]));
    for (const transfer of suggestSettlements(members)) {
      after.set(transfer.from, (after.get(transfer.from) ?? 0) + transfer.amount);
      after.set(transfer.to, (after.get(transfer.to) ?? 0) - transfer.amount);
    }
    expect([...after.values()].every(balance => balance === 0)).toBe(true);
  });

  it('refuses balances that do not add up to 0, as a corrupted ledger', () => {
    expect(() => suggestSettlements([{ memberId: 'a', balance: 5 }])).toThrow(/corrupted/);
  });
});
