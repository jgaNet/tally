import { stillOwed } from './StillOwed';

describe('stillOwed (request 13, ADR 12)', () => {
  it('counts a waiting payment as paid: the payer owes less, the payee is owed less', () => {
    const balances = new Map([
      ['ada', 30],
      ['grace', -30],
      ['linus', 0],
    ]);
    const owed = stillOwed(balances, [{ from: 'grace', to: 'ada', amount: 10 }]);
    expect(owed.get('ada')).toBe(20);
    expect(owed.get('grace')).toBe(-20);
    expect(owed.get('linus')).toBe(0);
  });

  it('leaves the balances as they are when nothing waits, and never changes the ones given', () => {
    const balances = new Map([['ada', 5]]);
    expect(stillOwed(balances, [])).toEqual(new Map([['ada', 5]]));
    stillOwed(balances, [{ from: 'grace', to: 'ada', amount: 5 }]);
    expect(balances.get('ada')).toBe(5);
  });

  it('adds up to 0 whenever the balances given do', () => {
    const owed = stillOwed(
      new Map([
        ['ada', 10],
        ['grace', -10],
      ]),
      [
        { from: 'grace', to: 'linus', amount: 4 },
        { from: 'linus', to: 'ada', amount: 1 },
      ],
    );
    const sum = [...owed.values()].reduce((total, balance) => total + balance, 0);
    expect(sum).toBe(0);
  });
});
