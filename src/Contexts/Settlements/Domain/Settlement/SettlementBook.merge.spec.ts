import { Id } from '@Architecture/Domain';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/** The book of a group merged into another is taken in by the book kept (request 31). */

const at = new Date('2026-01-01T10:00:00.000Z');
const later = new Date('2026-01-02T10:00:00.000Z');
const payer = new Id('payer');
const payee = new Id('payee');
const members = ['payer', 'payee'];
const balances = new Map([
  ['payer', -30],
  ['payee', 30],
]);

describe('SettlementBook merged (request 31)', () => {
  it('takes every settlement of the book merged, each with its id, status and history, and records SettlementBookMerged', () => {
    const kept = SettlementBook.open(new Id('kept'), 4);
    const merged = SettlementBook.open(new Id('merged'), 2);
    const recorded = merged.recordCash({ groupArchived: false, payer, payee, amount: 30, balances, members, at });
    if (recorded.isFailure()) throw new Error('the cash settlement must be recorded');
    merged.pullDomainEvents();

    kept.absorb(merged, later);

    expect(kept.unsaved).toEqual([
      expect.objectContaining({
        id: recorded.data.id,
        groupId: new Id('kept'),
        status: 'paid',
        history: [{ status: 'paid', at }],
      }),
    ]);
    expect(kept.unsavedHistory).toEqual([]);
    const events = kept.pullDomainEvents();
    expect(events.map(event => event.name)).toEqual(['SettlementBookMergedEvent']);
    expect(events[0].payload).toEqual({
      groupId: 'kept',
      mergedGroupId: 'merged',
      settlementIds: [recorded.data.id.value],
      mergedAt: later.toISOString(),
    });
    expect(merged.pullDomainEvents()).toEqual([]);
  });
});
