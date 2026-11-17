import { stillOwed } from '@Contexts/Settlements/Domain/Settlement/OutstandingDebts';

describe('stillOwed (request 18)', () => {
  it('lists the members who owe, by what they owe, and no one owed or even', () => {
    const owing = stillOwed({
      members: ['ann', 'ben', 'cy'],
      balances: [
        { memberId: 'ann', balance: 3000 },
        { memberId: 'ben', balance: -2500 },
        { memberId: 'cy', balance: 0 },
      ],
      waiting: [],
    });

    expect(owing).toEqual([{ memberId: 'ben', owes: 2500 }]);
  });

  it('counts a payment waiting at the provider as paid: the payer owes less, the payee is owed less', () => {
    const owing = stillOwed({
      members: ['ann', 'ben'],
      balances: [
        { memberId: 'ann', balance: 4000 },
        { memberId: 'ben', balance: -4000 },
      ],
      waiting: [{ from: 'ben', to: 'ann', amount: 1500 }],
    });

    expect(owing).toEqual([{ memberId: 'ben', owes: 2500 }]);
  });

  it('lists nobody a waiting payment has paid off, and nobody who is not a current member', () => {
    const owing = stillOwed({
      members: ['ben'],
      balances: [
        { memberId: 'ben', balance: -2000 },
        { memberId: 'former', balance: -9000 },
      ],
      waiting: [{ from: 'ben', to: 'ann', amount: 2000 }],
    });

    expect(owing).toEqual([]);
  });
});
