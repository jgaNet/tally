import { describe, expect, it } from '@jest/globals';

import {
  GroupNotFoundException,
  InvalidSettlementAmountException,
  MoreThanPayeeIsOwedException,
  MoreThanPayerOwesException,
  PayeeIsPayerException,
  PayerNotInGroupException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import { SettlementBook, SettlementRecordedEvent } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

const NOW = new Date('2026-03-01T10:00:00.000Z');

/** Ann is owed 1000 by Bob; Cy owes 500 and Dan 500 (the balances add up to 0). Members in the order they joined. */
const book = (version = 0) =>
  SettlementBook.open({
    currency: 'EUR',
    groupId: 'group-1',
    version,
    members: ['ann', 'bob', 'cy', 'dan'],
    balances: [
      { memberId: 'ann', balance: 1000 },
      { memberId: 'bob', balance: -1000 },
      { memberId: 'cy', balance: -500 },
      { memberId: 'dan', balance: -500 },
    ],
  });

describe('a cash settlement, decided by its payee', () => {
  it('records a paid settlement in cash, with its identity generated, and records SettlementRecorded', () => {
    const aggregate = book();

    const recorded = aggregate.recordCash({ from: 'bob', to: 'ann', amount: 400 }, false, false, NOW);

    expect(recorded.isFailure()).toBe(false);
    expect(recorded.data).toEqual({
      id: expect.any(String),
      groupId: 'group-1',
      from: 'bob',
      to: 'ann',
      amount: 400,
      method: 'cash',
      status: 'paid',
      at: '2026-03-01T10:00:00.000Z',
    });
    const events = aggregate.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(SettlementRecordedEvent);
    expect(events[0].payload).toEqual({
      settlementId: recorded.data?.id,
      groupId: 'group-1',
      from: 'bob',
      to: 'ann',
      amount: 400,
      at: '2026-03-01T10:00:00.000Z',
    });
  });

  it('may settle the whole of what the payer owes, when the payee is owed as much', () => {
    expect(book().recordCash({ from: 'bob', to: 'ann', amount: 1000 }, false, false, NOW).isFailure()).toBe(false);
  });

  it('refuses an amount that is not a whole number of 1 or more, and records nothing', () => {
    for (const amount of [0, -5, 1.5]) {
      const aggregate = book();
      const refused = aggregate.recordCash({ from: 'bob', to: 'ann', amount }, false, false, NOW);
      expect(refused.error).toBeInstanceOf(InvalidSettlementAmountException);
      expect(aggregate.pullDomainEvents()).toEqual([]);
    }
  });

  it('refuses a payer who is the payee', () => {
    const refused = book().recordCash({ from: 'ann', to: 'ann', amount: 100 }, false, false, NOW);
    expect(refused.error).toBeInstanceOf(PayeeIsPayerException);
  });

  it('refuses a payer who is not a member of the group', () => {
    const refused = book().recordCash({ from: 'eve', to: 'ann', amount: 100 }, false, false, NOW);
    expect(refused.error).toBeInstanceOf(PayerNotInGroupException);
  });

  it('answers the group is not there for a payee who is not a member', () => {
    const refused = book().recordCash({ from: 'bob', to: 'eve', amount: 100 }, false, false, NOW);
    expect(refused.error).toBeInstanceOf(GroupNotFoundException);
  });

  it('refuses more than the payer owes, including a payer who owes nothing', () => {
    const more = book().recordCash({ from: 'cy', to: 'ann', amount: 501 }, false, false, NOW);
    expect(more.error).toBeInstanceOf(MoreThanPayerOwesException);

    // Ann is owed, so she owes nothing: a payment from her is more than she owes.
    const owesNothing = book().recordCash({ from: 'ann', to: 'cy', amount: 1 }, false, false, NOW);
    expect(owesNothing.error).toBeInstanceOf(MoreThanPayerOwesException);
  });

  it('refuses more than the payee is owed, though the payer owes it', () => {
    // Bob owes 1000 and Ann is owed 1000; after Cy's 500 is settled to Ann, Ann is owed 500 and Bob still owes 1000.
    const afterCy = SettlementBook.open({
      currency: 'EUR',
      groupId: 'group-1',
      version: 1,
      members: ['ann', 'bob', 'cy'],
      balances: [
        { memberId: 'ann', balance: 500 },
        { memberId: 'bob', balance: -1000 },
        { memberId: 'cy', balance: -500 },
      ],
    });
    const refused = afterCy.recordCash({ from: 'bob', to: 'ann', amount: 600 }, false, false, NOW);
    expect(refused.error).toBeInstanceOf(MoreThanPayeeIsOwedException);
  });

  it('keeps the version it was read at, and never changes it', () => {
    expect(book(4).version).toBe(4);
    book(4).recordCash({ from: 'bob', to: 'ann', amount: 100 }, false, false, NOW);
    expect(book(4).version).toBe(4);
  });
});
