import { describe, expect, it } from '@jest/globals';

import { NettingGroup, planNetting } from '@Contexts/Settlements/Domain/Netting/NetDebts';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

const ANN = 'ann';
const BOB = 'bob';

/** A group's book as the ledger counts it: the members in the order they joined, and each one's balance (negative: owes). */
const group = (groupId: string, balances: Record<string, number>, archived = false): NettingGroup => ({
  groupId,
  archived,
  book: SettlementBook.open({
    groupId,
    version: 0,
    members: Object.keys(balances),
    balances: Object.entries(balances).map(([memberId, balance]) => ({ memberId, balance })),
  }),
});

describe('planNetting (request 32, the storm’s NetDebts decision)', () => {
  it('nets the smaller of what each owes the other across the groups, paying group by group in the order made', () => {
    // Ann owes Bob 300 in the flat and 200 in the trip, made later; Bob owes Ann 400 in the club.
    const plan = planNetting(ANN, BOB, [
      group('flat', { [ANN]: -300, [BOB]: 300 }),
      group('trip', { [ANN]: -200, [BOB]: 200 }),
      group('club', { [ANN]: 400, [BOB]: -400 }),
    ]);

    expect(plan).toEqual({
      amount: 400,
      payments: [
        { groupId: 'flat', from: ANN, to: BOB, amount: 300 },
        { groupId: 'trip', from: ANN, to: BOB, amount: 100 },
        { groupId: 'club', from: BOB, to: ANN, amount: 400 },
      ],
    });
  });

  it('nets nothing, and so refuses, when one way has nothing to pay', () => {
    expect(planNetting(ANN, BOB, [group('flat', { [ANN]: -300, [BOB]: 300 })])).toBeUndefined();
  });

  it('leaves an archived group out of what can be netted', () => {
    const plan = planNetting(ANN, BOB, [
      group('flat', { [ANN]: -300, [BOB]: 300 }),
      group('trip', { [ANN]: -200, [BOB]: 200 }, true),
      group('club', { [ANN]: 400, [BOB]: -400 }),
    ]);

    expect(plan?.amount).toBe(300);
    expect(plan?.payments).toEqual([
      { groupId: 'flat', from: ANN, to: BOB, amount: 300 },
      { groupId: 'club', from: BOB, to: ANN, amount: 300 },
    ]);
  });

  it('counts a payment waiting at the provider as paid, so it is not netted again', () => {
    const waiting = SettlementBook.open({
      groupId: 'flat',
      version: 1,
      members: [ANN, BOB],
      balances: [
        { memberId: ANN, balance: -300 },
        { memberId: BOB, balance: 300 },
      ],
      waiting: [{ from: ANN, to: BOB, amount: 300 }],
    });
    const club = group('club', { [ANN]: 400, [BOB]: -400 });

    expect(planNetting(ANN, BOB, [{ groupId: 'flat', book: waiting, archived: false }, club])).toBeUndefined();
  });
});
