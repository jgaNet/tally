import { decideContestSettlement, decideDecideContest } from './SettlementBook.decision';
import { SettlementBook, SettlementStatus } from './SettlementBook';

const now = new Date('2026-03-01T10:00:00Z');
const settlement = (status: SettlementStatus = 'paid', history: SettlementStatus[] = ['pending', 'paid']) => ({
  id: 's1',
  from: 'grace',
  to: 'ada',
  method: 'provider' as const,
  status,
  history: history.map(each => ({ status: each })),
});
const given = { memberIds: ['ada', 'grace'], archived: false, settlement: settlement() };
const refusal = (decision: { error?: unknown }) => (decision.error as { type: string } | undefined)?.type;

describe('decideContestSettlement (request 33)', () => {
  it('allows the payee to contest a paid settlement through the provider, once', () => {
    const decision = decideContestSettlement(given, { caller: 'ada' }, now);
    expect(decision.data?.state).toEqual({ id: 's1' });
  });

  it('refuses anyone but the payee, a settlement not paid or not through the provider, and a second contest', () => {
    expect(refusal(decideContestSettlement(given, { caller: 'grace' }, now))).toBe('NotAllowed');
    expect(
      refusal(
        decideContestSettlement({ ...given, settlement: settlement('pending', ['pending']) }, { caller: 'ada' }, now),
      ),
    ).toBe('SettlementNotPaid');
    expect(
      refusal(
        decideContestSettlement({ ...given, settlement: { ...settlement(), method: 'cash' } }, { caller: 'ada' }, now),
      ),
    ).toBe('SettlementNotThroughProvider');
    const contestedBefore = settlement('paid', ['pending', 'paid', 'contested', 'paid']);
    expect(refusal(decideContestSettlement({ ...given, settlement: contestedBefore }, { caller: 'ada' }, now))).toBe(
      'SettlementAlreadyContested',
    );
  });

  it('refuses when the payer or the payee left the group, and in an archived group', () => {
    expect(refusal(decideContestSettlement({ ...given, memberIds: ['ada'] }, { caller: 'ada' }, now))).toBe(
      'ContestPartyNotMember',
    );
    expect(refusal(decideContestSettlement({ ...given, archived: true }, { caller: 'ada' }, now))).toBe(
      'GroupArchived',
    );
  });
});

describe('decideDecideContest (request 33)', () => {
  it('decides a contested settlement only', () => {
    expect(decideDecideContest({ settlement: settlement('contested') }, { paid: true }, now).data?.state).toEqual({
      id: 's1',
    });
    expect(refusal(decideDecideContest({ settlement: settlement('paid') }, { paid: true }, now))).toBe(
      'SettlementNotContested',
    );
    expect(refusal(decideDecideContest({ settlement: settlement('annulled') }, { paid: false }, now))).toBe(
      'SettlementNotContested',
    );
  });
});

describe('SettlementBook contest and decision (request 33)', () => {
  const paidBook = () =>
    SettlementBook.fromSnapshot({
      id: 'b',
      groupId: 'g',
      version: 2,
      payments: [
        {
          id: 's1',
          from: 'grace',
          to: 'ada',
          amount: 30,
          settled: 30,
          providerPaymentId: 'pay_1',
          payUrl: 'u',
          status: 'paid',
        },
      ],
    });
  const balances = new Map([
    ['ada', 30],
    ['grace', -30],
  ]);

  it('waits as a pending payment does while contested, and a webhook changes nothing', () => {
    const book = paidBook();
    book.contest('s1', now);
    expect(book.pendingPayments()).toHaveLength(1);
    expect(book.stillOwed(balances).get('grace')).toBe(0);
    book.settlePayment('pay_1', 'refunded', now);
    expect(book.moved()).toEqual([{ id: 's1', status: 'contested', at: now.toISOString() }]);
  });

  it('is paid again, by the administrator, or annulled and no longer waits; each is an entry of the log', () => {
    const paid = paidBook();
    paid.contest('s1', now);
    paid.decideContest({ settlementId: 's1', paid: true, by: 'root', at: now });
    expect(paid.pendingPayments()).toEqual([]);
    expect(paid.providerPaymentOf('s1')).toBe('pay_1');
    expect(paid.decisions()).toEqual([
      expect.objectContaining({ by: 'root', action: 'decided-paid', subjectId: 's1' }),
    ]);
    expect(paid.pullDomainEvents().map(event => event.constructor.name)).toEqual([
      'SettlementContestedEvent',
      'SettlementPaidEvent',
    ]);

    const annulled = paidBook();
    annulled.contest('s1', now);
    annulled.decideContest({ settlementId: 's1', paid: false, by: 'root', at: now });
    expect(annulled.providerPaymentOf('s1')).toBeUndefined();
    expect(annulled.stillOwed(balances).get('grace')).toBe(-30);
    expect(annulled.decisions()[0]).toMatchObject({ action: 'decided-annulled' });
    expect(annulled.pullDomainEvents().map(event => event.constructor.name)).toEqual([
      'SettlementContestedEvent',
      'SettlementAnnulledEvent',
    ]);
  });

  it('throws on a programming error: contesting what is not paid, deciding what is not contested', () => {
    expect(() => paidBook().decideContest({ settlementId: 's1', paid: true, by: 'root', at: now })).toThrow();
    expect(() => paidBook().contest('unknown', now)).toThrow();
  });
});
