import { decideNetDebts, NetDebtsGiven } from './Netting.decision';

const at = new Date('2026-01-01T00:00:00Z');
const balancesOf = (entries: [string, number][]) => new Map(entries);

/** Ann owes Bob 300 in the flat and 200 in the trip, created later; Bob owes Ann 400 in the club (request 32). */
const example: NetDebtsGiven = {
  suspended: false,
  groups: [
    {
      groupId: 'flat',
      currency: 'EUR',
      archived: false,
      balances: balancesOf([
        ['ann', -300],
        ['bob', 300],
      ]),
    },
    {
      groupId: 'trip',
      currency: 'EUR',
      archived: false,
      balances: balancesOf([
        ['ann', -200],
        ['bob', 200],
      ]),
    },
    {
      groupId: 'club',
      currency: 'EUR',
      archived: false,
      balances: balancesOf([
        ['ann', 400],
        ['bob', -400],
      ]),
    },
  ],
};

describe('decideNetDebts (request 32)', () => {
  it('nets the smaller of the two totals, and pays it group by group, earliest first, each way', () => {
    const decision = decideNetDebts(example, { by: 'ann', with: 'bob', currency: 'EUR' }, at);
    expect(decision.isFailure()).toBe(false);
    expect(decision.data!.state).toEqual({
      by: 'ann',
      with: 'bob',
      currency: 'EUR',
      amount: 400,
      transfers: [
        { groupId: 'flat', from: 'ann', to: 'bob', amount: 300 },
        { groupId: 'trip', from: 'ann', to: 'bob', amount: 100 },
        { groupId: 'club', from: 'bob', to: 'ann', amount: 400 },
      ],
    });
  });

  it('nets from the other side the same way: the asker pays first, in the groups where it can', () => {
    const decision = decideNetDebts(example, { by: 'bob', with: 'ann', currency: 'EUR' }, at);
    expect(decision.data!.state.amount).toBe(400);
    expect(decision.data!.state.transfers).toEqual([
      { groupId: 'club', from: 'bob', to: 'ann', amount: 400 },
      { groupId: 'flat', from: 'ann', to: 'bob', amount: 300 },
      { groupId: 'trip', from: 'ann', to: 'bob', amount: 100 },
    ]);
  });

  it('leaves out an archived group and a group in another currency', () => {
    const given: NetDebtsGiven = {
      suspended: false,
      groups: [
        {
          groupId: 'old',
          currency: 'EUR',
          archived: true,
          balances: balancesOf([
            ['ann', -50],
            ['bob', 50],
          ]),
        },
        {
          groupId: 'usd',
          currency: 'USD',
          archived: false,
          balances: balancesOf([
            ['ann', -70],
            ['bob', 70],
          ]),
        },
        {
          groupId: 'eur',
          currency: 'EUR',
          archived: false,
          balances: balancesOf([
            ['ann', -10],
            ['bob', 10],
          ]),
        },
        {
          groupId: 'eur-back',
          currency: 'EUR',
          archived: false,
          balances: balancesOf([
            ['ann', 5],
            ['bob', -5],
          ]),
        },
      ],
    };
    // Counting the archived group and the USD one would net 50 or 70 more on Ann's side; left out, 10 and 5 net 5.
    const decision = decideNetDebts(given, { by: 'ann', with: 'bob', currency: 'EUR' }, at);
    expect(decision.data!.state.amount).toBe(5);
    expect(decision.data!.state.transfers).toEqual([
      { groupId: 'eur', from: 'ann', to: 'bob', amount: 5 },
      { groupId: 'eur-back', from: 'bob', to: 'ann', amount: 5 },
    ]);
  });

  it("refuses a netting with oneself, a currency that is not Tally's, and a netting with nothing to net, which nets nothing", () => {
    const self = decideNetDebts(example, { by: 'ann', with: 'ann', currency: 'EUR' }, at);
    expect((self.error as { type: string }).type).toBe('NettingWithSelf');
    const unknown = decideNetDebts(example, { by: 'ann', with: 'bob', currency: 'XYZ' }, at);
    expect((unknown.error as { type: string }).type).toBe('NettingCurrencyUnknown');
    const nothing = decideNetDebts(
      {
        suspended: false,
        groups: [
          {
            groupId: 'flat',
            currency: 'EUR',
            archived: false,
            balances: balancesOf([
              ['ann', -300],
              ['bob', 300],
            ]),
          },
        ],
      },
      { by: 'ann', with: 'bob', currency: 'EUR' },
      at,
    );
    expect((nothing.error as { type: string }).type).toBe('NothingToNet');
  });
});
