import { Id } from '@Architecture/Domain';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { NetDebts, NettingGroup, refusalOfNetting } from '@Contexts/Settlements/Domain/Netting/NetDebts';

/** Two people netting what they owe each other across their groups (request 32). */

const at = new Date('2026-03-01T10:00:00.000Z');
const ann = new Id('ann');
const bob = new Id('bob');
const members = ['ann', 'bob'];

/** A group the two share, with the balances as Ledger reads them (positive: owed to the member), and no settlement yet. */
function group(id: string, annBalance: number): NettingGroup {
  return {
    groupId: new Id(id),
    book: SettlementBook.open(new Id(id), 1),
    balances: new Map([
      ['ann', annBalance],
      ['bob', -annBalance],
    ]),
    members,
  };
}

describe('netDebts (request 32)', () => {
  it('nets the smaller of the two totals, group by group, in the order the groups were created', () => {
    // Ann owes Bob 300 in the flat and 200 in the trip, created later; Bob owes Ann 400 in the club.
    const flat = group('flat', -300);
    const trip = group('trip', -200);
    const club = group('club', 400);

    const plan = NetDebts.net({ by: ann, with: bob, currency: 'EUR', groups: [flat, trip, club], at });

    if (plan.isFailure()) throw new Error('the netting must be decided');
    expect(plan.data.amount).toBe(400);
    expect(
      plan.data.settlements.map(settlement => [settlement.payer.value, settlement.payee.value, settlement.amount]),
    ).toEqual([
      ['ann', 'bob', 300],
      ['ann', 'bob', 100],
      ['bob', 'ann', 400],
    ]);
    expect(plan.data.settlements.every(settlement => settlement.method === 'net')).toBe(true);
    expect(plan.data.settlements.every(settlement => settlement.status === 'paid')).toBe(true);
  });

  it('refuses a netting with nothing owed both ways, and records nothing', () => {
    const flat = group('flat', -300);
    const trip = group('trip', -200);

    const plan = NetDebts.net({ by: ann, with: bob, currency: 'EUR', groups: [flat, trip], at });

    expect(plan.isFailure()).toBe(true);
    expect(flat.book.unsaved).toHaveLength(0);
    expect(trip.book.unsaved).toHaveLength(0);
  });

  it('counts a payment waiting at the provider as paid, so it is not netted again', () => {
    const flat = group('flat', -300);
    const club = group('club', 400);
    // A payment of 300 Ann makes to Bob in the flat waits at the provider: Ann owes nothing there any more.
    const waiting = SettlementBook.open(new Id('flat'), 1, [
      {
        id: new Id('waiting'),
        groupId: new Id('flat'),
        payer: ann,
        payee: bob,
        amount: 300,
        method: 'provider',
        status: 'pending',
        at,
        history: [{ status: 'pending', at }],
        providerPaymentId: 'p1',
        payUrl: 'https://pay.example/p1',
      },
    ]);
    const flatWaiting = { ...flat, book: waiting };

    const plan = NetDebts.net({ by: ann, with: bob, currency: 'EUR', groups: [flatWaiting, club], at });

    expect(plan.isFailure()).toBe(true);
  });

  it("refuses a netting with oneself, and one in a currency that is not Tally's", () => {
    const flat = group('flat', -300);
    const club = group('club', 400);

    const self = NetDebts.net({ by: ann, with: ann, currency: 'EUR', groups: [flat, club], at });
    const unknown = NetDebts.net({ by: ann, with: bob, currency: 'XYZ', groups: [flat, club], at });

    expect(self.isFailure() && self.error?.type).toBe('NettingWithOneself');
    expect(unknown.isFailure() && unknown.error?.type).toBe('UnknownNettingCurrency');
  });
});

describe('netting with a deleted account (request 35)', () => {
  it('is refused by AccountDeleted before any group is read', () => {
    const refusal = refusalOfNetting({ by: ann, with: bob, currency: 'EUR', otherDeleted: true });
    expect(refusal?.type).toBe('AccountDeleted');
    expect(refusalOfNetting({ by: ann, with: bob, currency: 'EUR' })).toBeUndefined();
  });
});
