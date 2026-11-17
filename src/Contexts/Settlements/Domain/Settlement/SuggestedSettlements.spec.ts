import { describe, expect, it } from '@jest/globals';

import { MemberBalance, suggestSettlements } from '@Contexts/Settlements/Domain/Settlement/SuggestedSettlements';

/** Applies the transfers to the balances, the way the members read them: each balance moved by what it paid or was paid. */
function applied(balances: MemberBalance[], transfers: { from: string; to: string; amount: number }[]) {
  const result = new Map(balances.map(({ memberId, balance }) => [memberId, balance]));
  for (const { from, to, amount } of transfers) {
    result.set(from, (result.get(from) ?? 0) + amount);
    result.set(to, (result.get(to) ?? 0) - amount);
  }
  return result;
}

describe('suggestSettlements (request 11)', () => {
  it('makes the transfers of the stated example, in the order made', () => {
    // Ann 500, Bob 100, Cy -300, Dan -300, who joined in that order: Cy pays Ann 300; then Dan pays Ann 200; then Dan pays Bob 100.
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

  it('answers no transfer when every balance is already 0', () => {
    expect(
      suggestSettlements([
        { memberId: 'ann', balance: 0 },
        { memberId: 'bob', balance: 0 },
      ]),
    ).toEqual([]);
    expect(suggestSettlements([])).toEqual([]);
  });

  it('takes, of two members who owe the same, the one who joined first, and of two who are owed the same, the same', () => {
    // Bob and Cy both owe 200 and Ann and Dan are both owed 200: Bob pays Ann, then Cy pays Dan.
    expect(
      suggestSettlements([
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

  it('pays the smaller of what the payer owes and what the payee is owed, and the balance at 0 is even', () => {
    const transfers = suggestSettlements([
      { memberId: 'ann', balance: 100 },
      { memberId: 'bob', balance: -400 },
      { memberId: 'cy', balance: 300 },
    ]);
    // Bob (owes most) pays Cy (owed most) 300; then Bob pays Ann 100.
    expect(transfers).toEqual([
      { from: 'bob', to: 'cy', amount: 300 },
      { from: 'bob', to: 'ann', amount: 100 },
    ]);
  });

  it('never makes more transfers than the members whose balance is not 0, less one, and every amount is at least 1', () => {
    const balances: MemberBalance[] = [
      { memberId: 'a', balance: 1000 },
      { memberId: 'b', balance: 0 },
      { memberId: 'c', balance: -250 },
      { memberId: 'd', balance: 75 },
      { memberId: 'e', balance: -825 },
      { memberId: 'f', balance: 0 },
    ];
    const transfers = suggestSettlements(balances);
    const notZero = balances.filter(({ balance }) => balance !== 0).length;
    expect(transfers.length).toBeLessThanOrEqual(notZero - 1);
    for (const { amount } of transfers) expect(amount).toBeGreaterThanOrEqual(1);
  });

  it('brings every balance to 0, whatever the balances are', () => {
    const balances: MemberBalance[] = [
      { memberId: 'a', balance: 37 },
      { memberId: 'b', balance: -12 },
      { memberId: 'c', balance: -25 },
      { memberId: 'd', balance: 9 },
      { memberId: 'e', balance: -9 },
    ];
    const after = applied(balances, suggestSettlements(balances));
    for (const { memberId } of balances) expect(after.get(memberId)).toBe(0);
  });

  it('answers the same transfers for the same balances, every time', () => {
    const balances: MemberBalance[] = [
      { memberId: 'a', balance: 5 },
      { memberId: 'b', balance: -3 },
      { memberId: 'c', balance: -2 },
    ];
    expect(suggestSettlements(balances)).toEqual(suggestSettlements(balances));
  });
});
