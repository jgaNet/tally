import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import {
  BudgetPassedEvent,
  BudgetRemovedEvent,
  BudgetSetEvent,
} from '@Contexts/Ledger/Domain/Budget/Events/BudgetEvents';

const OWNER = { memberId: 'ada', role: 'owner' as const };
const MEMBER = { memberId: 'ben', role: 'member' as const };
const MEMBERS = [OWNER, MEMBER];

/** A budget of a group that is stored: version 1, with the amount given and the months passed. */
const stored = (amount: number | undefined, passedMonths: string[] = []) =>
  Budget.fromSnapshot({
    id: 'b1',
    groupId: 'flat',
    category: 'groceries',
    ...(amount === undefined ? {} : { amount }),
    passedMonths,
    version: 1,
  });

describe('Budget.setAmount', () => {
  it("is the group's owner's, and sets the amount, recording BudgetSet", () => {
    const set = Budget.open({ groupId: 'flat', category: 'groceries' }).setAmount({
      archived: false,
      by: 'ada',
      members: MEMBERS,
      amount: 400,
    });
    expect(set.isSuccess()).toBe(true);
    expect(set.data?.amount).toBe(400);
    const events = set.data?.pullDomainEvents() ?? [];
    expect(events).toEqual([
      BudgetSetEvent.set({ budgetId: set.data?.id ?? '', groupId: 'flat', category: 'groceries', amount: 400 }),
    ]);
  });

  it('refuses any other member, and an amount that is not from 1 to 100 000 000', () => {
    expect(stored(undefined).setAmount({ archived: false, by: 'ben', members: MEMBERS, amount: 400 }).isFailure()).toBe(
      true,
    );
    expect(stored(undefined).setAmount({ archived: false, by: 'ada', members: MEMBERS, amount: 0 }).isFailure()).toBe(
      true,
    );
    expect(
      stored(undefined).setAmount({ archived: false, by: 'ada', members: MEMBERS, amount: 100_000_001 }).isFailure(),
    ).toBe(true);
    expect(
      stored(undefined).setAmount({ archived: false, by: 'ada', members: MEMBERS, amount: 100_000_000 }).isSuccess(),
    ).toBe(true);
  });

  it('keeps the months it was passed in, so setting it again tells nothing new', () => {
    const changed = stored(300, ['2026-11']).setAmount({ archived: false, by: 'ada', members: MEMBERS, amount: 500 });
    expect(changed.data?.toSnapshot().passedMonths).toEqual(['2026-11']);
  });
});

describe('Budget.unset', () => {
  it('removes the amount for the owner, keeps the months, and refuses when none is set', () => {
    const removed = stored(300, ['2026-11']).unset({ archived: false, by: 'ada', members: MEMBERS });
    expect(removed.data?.amount).toBeUndefined();
    expect(removed.data?.toSnapshot().passedMonths).toEqual(['2026-11']);
    expect(removed.data?.pullDomainEvents()).toEqual([
      BudgetRemovedEvent.set({ budgetId: 'b1', groupId: 'flat', category: 'groceries' }),
    ]);
    expect(stored(undefined).unset({ archived: false, by: 'ada', members: MEMBERS }).isFailure()).toBe(true);
    expect(stored(300).unset({ archived: false, by: 'ben', members: MEMBERS }).isFailure()).toBe(true);
  });
});

describe('Budget.pass', () => {
  const memberIds = ['ada', 'ben'];

  it('passes a month that spends more than the budget, once, recording BudgetPassed for the members to tell', () => {
    const passed = stored(400).pass({ month: '2026-11', spent: 450, memberIds });
    expect(passed.toSnapshot().passedMonths).toEqual(['2026-11']);
    expect(passed.pullDomainEvents()).toEqual([
      BudgetPassedEvent.set({
        budgetId: 'b1',
        groupId: 'flat',
        category: 'groceries',
        month: '2026-11',
        budget: 400,
        spent: 450,
        memberIds,
      }),
    ]);
  });

  it('changes nothing when no budget is set, the month is not over it, or the month was passed already', () => {
    const none = stored(undefined);
    expect(none.pass({ month: '2026-11', spent: 999, memberIds })).toBe(none);
    const under = stored(400);
    expect(under.pass({ month: '2026-11', spent: 400, memberIds })).toBe(under);
    const told = stored(400, ['2026-11']);
    expect(told.pass({ month: '2026-11', spent: 900, memberIds })).toBe(told);
    // A later month that goes over is a month of its own.
    expect(told.pass({ month: '2026-12', spent: 900, memberIds }).toSnapshot().passedMonths).toEqual([
      '2026-11',
      '2026-12',
    ]);
  });
});
