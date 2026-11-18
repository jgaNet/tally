import { describe, expect, it } from '@jest/globals';

import { NotAllowedException } from '@Architecture/Domain';
import { GroupArchivedException } from '@SharedKernel/Domain';

import {
  ContestNotPayeeException,
  ContestPartyLeftException,
  SettlementNotContestableException,
  SettlementNotContestedException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import {
  SettlementAnnulledEvent,
  SettlementBook,
  SettlementContestedEvent,
  SettlementPaidEvent,
  WaitingPayment,
} from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { Settlement, SettlementStatus } from '@Contexts/Settlements/Domain/Settlement/Settlement';

const now = new Date('2026-03-02T09:00:00.000Z');
const at = now.toISOString();

/**
 * Ann is owed 1000 by Bob, as the ledger counts it. `waiting` is what the book counts as paid on top of that: a payment waiting at the provider,
 * or a contested one, which the balances do not count (request 33). Members in the order they joined.
 */
const book = (members = ['ann', 'bob', 'cy', 'dan'], waiting: WaitingPayment[] = []) =>
  SettlementBook.open({
    groupId: 'group-1',
    version: 0,
    members,
    balances: [
      { memberId: 'ann', balance: 1000 },
      { memberId: 'bob', balance: -1000 },
      { memberId: 'cy', balance: 0 },
      { memberId: 'dan', balance: 0 },
    ],
    waiting,
  });

/** A settlement through the provider from Bob to Ann, in the given status. */
const provider = (status: SettlementStatus, contestedAt?: string): Settlement => ({
  id: 'settlement-1',
  groupId: 'group-1',
  from: 'bob',
  to: 'ann',
  amount: 400,
  method: 'provider',
  status,
  at: '2026-03-01T10:00:00.000Z',
  payment: { id: 'pay-1', payUrl: 'https://pay.example/pay-1' },
  ...(contestedAt !== undefined && { contestedAt }),
});

/** A settlement recorded in cash from Bob to Ann. */
const cash: Settlement = {
  id: 'settlement-2',
  groupId: 'group-1',
  from: 'bob',
  to: 'ann',
  amount: 400,
  method: 'cash',
  status: 'paid',
  at: '2026-03-01T10:00:00.000Z',
};

describe('a contest by the payee of a settlement paid through the provider', () => {
  it('is contested, held, and SettlementContested is recorded with its time', () => {
    const aggregate = book();

    const contested = aggregate.contest(provider('paid'), 'ann', false, now);

    expect(contested.data).toEqual({ ...provider('paid'), status: 'contested', contestedAt: at });
    const events = aggregate.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(SettlementContestedEvent);
    expect(events[0].payload).toEqual({
      settlementId: 'settlement-1',
      groupId: 'group-1',
      from: 'bob',
      to: 'ann',
      amount: 400,
      at,
    });
  });

  it('is refused for the payer or another member, and nothing is recorded', () => {
    expect(book().contest(provider('paid'), 'bob', false, now).error).toBeInstanceOf(ContestNotPayeeException);
    expect(book().contest(provider('paid'), 'bob', false, now).error).toBeInstanceOf(NotAllowedException);
    expect(book().contest(provider('paid'), 'cy', false, now).error).toBeInstanceOf(ContestNotPayeeException);
  });

  it('is refused unless the settlement is paid through the provider, and not contested before', () => {
    expect(book().contest(cash, 'ann', false, now).error).toBeInstanceOf(SettlementNotContestableException);
    for (const status of ['pending', 'failed', 'refunding', 'refunded', 'contested', 'annulled'] as const) {
      expect(book().contest(provider(status), 'ann', false, now).error).toBeInstanceOf(
        SettlementNotContestableException,
      );
    }
    // Once contested, decided paid again, it is `paid` but was contested before: it is not contested again.
    expect(book().contest(provider('paid', at), 'ann', false, now).error).toBeInstanceOf(
      SettlementNotContestableException,
    );
  });

  it('is refused when its payer or its payee is no longer a member of the group', () => {
    expect(book(['ann', 'cy', 'dan']).contest(provider('paid'), 'ann', false, now).error).toBeInstanceOf(
      ContestPartyLeftException,
    );
    expect(book(['bob', 'cy', 'dan']).contest(provider('paid'), 'ann', false, now).error).toBeInstanceOf(
      ContestPartyLeftException,
    );
  });

  it('is refused in an archived group, which changes nothing', () => {
    const aggregate = book();

    expect(aggregate.contest(provider('paid'), 'ann', true, now).error).toBeInstanceOf(GroupArchivedException);
    expect(aggregate.pullDomainEvents()).toEqual([]);
  });
});

describe('a contested settlement, as the balances and the book count it', () => {
  it('counts for what is still owed, as a payment waiting at the provider, and not in the balances once contested', () => {
    // As the book opens it when the settlement is contested: the ledger's balances without it, and it waiting.
    const held = book(undefined, [{ from: 'bob', to: 'ann', amount: 400 }]);

    expect(held.balanceOf('ann')).toBe(600);
    expect(held.balanceOf('bob')).toBe(-600);
    expect(held.stillOwed().reduce((sum, row) => sum + row.balance, 0)).toBe(0);
  });
});

describe("an administrator's decision on a contested settlement", () => {
  const contested = provider('contested', at);

  it('that the money arrived makes it paid again, and SettlementPaid is recorded', () => {
    const aggregate = book();

    const decided = aggregate.decideContest(contested, true);

    expect(decided.data).toEqual({ ...contested, status: 'paid' });
    const events = aggregate.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(SettlementPaidEvent);
  });

  it('that it did not arrive annuls it, and SettlementAnnulled is recorded', () => {
    const aggregate = book();

    const decided = aggregate.decideContest(contested, false);

    expect(decided.data).toEqual({ ...contested, status: 'annulled' });
    const events = aggregate.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(SettlementAnnulledEvent);
  });

  it('is refused for a settlement that is not contested, which is decided once only', () => {
    for (const status of ['paid', 'pending', 'annulled'] as const) {
      expect(book().decideContest(provider(status, at), true).error).toBeInstanceOf(SettlementNotContestedException);
    }
    const aggregate = book();
    expect(aggregate.decideContest({ ...contested, status: 'paid' }, false).error).toBeInstanceOf(
      SettlementNotContestedException,
    );
    expect(aggregate.pullDomainEvents()).toEqual([]);
  });
});
