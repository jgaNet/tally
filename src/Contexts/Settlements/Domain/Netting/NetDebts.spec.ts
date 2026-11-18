import { Id } from '@Architecture/Domain';

import { NetDebts, SharedGroup } from '@Contexts/Settlements/Domain/Netting/NetDebts';

const ann = new Id('ann');
const bob = new Id('bob');
const group = (id: string, callerBalance: number, otherBalance: number): SharedGroup => ({
  groupId: new Id(id),
  callerBalance,
  otherBalance,
});

describe('NetDebts', () => {
  it('nets the smaller total, and pays it group by group in the order the groups were created (request 32)', () => {
    // Ann owes Bob 300 in the flat and 200 in the trip (created later); Bob owes Ann 400 in the club.
    const plan = NetDebts.plan({
      by: ann,
      withAccount: bob,
      groups: [group('flat', -300, 300), group('trip', -200, 200), group('club', 400, -400)],
    });

    expect(plan.isFailure()).toBe(false);
    expect(plan.data).toEqual({
      amount: 400,
      settlements: [
        { groupId: new Id('flat'), payer: ann, payee: bob, amount: 300 },
        { groupId: new Id('trip'), payer: ann, payee: bob, amount: 100 },
        { groupId: new Id('club'), payer: bob, payee: ann, amount: 400 },
      ],
    });
  });

  it('nets the smaller total when the sides differ: here Bob can pay 100 and Ann 300', () => {
    const plan = NetDebts.plan({
      by: ann,
      withAccount: bob,
      groups: [group('flat', -300, 300), group('club', 100, -100)],
    });

    expect(plan.isFailure()).toBe(false);
    expect(plan.data?.amount).toBe(100);
    expect(plan.data?.settlements).toEqual([
      { groupId: new Id('flat'), payer: ann, payee: bob, amount: 100 },
      { groupId: new Id('club'), payer: bob, payee: ann, amount: 100 },
    ]);
  });

  it('refuses a netting when one side can pay nothing', () => {
    const plan = NetDebts.plan({
      by: ann,
      withAccount: bob,
      groups: [group('flat', -300, 300), group('club', -50, 50)],
    });

    expect(plan.isFailure()).toBe(true);
    expect(plan.error?.type).toBe('NothingToNet');
  });

  it('nets nothing in a group where neither owes the other', () => {
    const plan = NetDebts.plan({ by: ann, withAccount: bob, groups: [group('flat', 0, 0)] });

    expect(plan.isFailure()).toBe(true);
    expect(plan.error?.type).toBe('NothingToNet');
  });
});
