import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { GroupMember } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/** A monthly budget of request 24, decided on its own: who may set it, its amount, and which months it passes. */
const MEMBERS: GroupMember[] = [
  { memberId: 'ana', role: 'owner' },
  { memberId: 'ben', role: 'member' },
];
const MEMBER_IDS = ['ana', 'ben'];

/** A budget of groceries set to `amount` by the owner, or changed from `budget` to it. */
function setTo(amount: number, budget: Budget = Budget.create({ groupId: 'group-1', category: 'groceries' })): Budget {
  const set = budget.setAmount({ setBy: 'ana', members: MEMBERS, amount });
  if (set.isFailure()) throw new Error(`The budget was refused: ${set.error.message}`);
  return set.data as Budget;
}

describe('Budget (request 24)', () => {
  it('is set by the group’s owner alone, from 1 to 100 000 000, and records BudgetSet', () => {
    const empty = Budget.create({ groupId: 'group-1', category: 'groceries' });

    expect(empty.setAmount({ setBy: 'ben', members: MEMBERS, amount: 400 }).isFailure()).toBe(true);
    expect(empty.setAmount({ setBy: 'ana', members: MEMBERS, amount: 0 }).isFailure()).toBe(true);
    expect(empty.setAmount({ setBy: 'ana', members: MEMBERS, amount: 100_000_001 }).isFailure()).toBe(true);
    expect(empty.setAmount({ setBy: 'ana', members: MEMBERS, amount: 100_000_000 }).isSuccess()).toBe(true);

    const set = setTo(40_000);
    expect(set.toSnapshot()).toMatchObject({ groupId: 'group-1', category: 'groceries', amount: 40_000 });
    expect(set.pullDomainEvents()).toHaveLength(1);
  });

  it('passes a month once, when its spending is more than the budget, and tells the members it was given', () => {
    const budget = setTo(40_000);

    expect(budget.decide({ month: '2026-11', spent: 40_000, memberIds: MEMBER_IDS })).toBeNull();

    const passed = budget.decide({ month: '2026-11', spent: 40_001, memberIds: MEMBER_IDS });
    expect(passed).not.toBeNull();
    const events = passed?.pullDomainEvents() ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      payload: {
        groupId: 'group-1',
        category: 'groceries',
        month: '2026-11',
        budget: 40_000,
        spent: 40_001,
        memberIds: MEMBER_IDS,
      },
    });
    expect(passed?.toSnapshot().passedMonths).toEqual(['2026-11']);
  });

  it('tells a month once, however often it goes over and back under, and tells a later month again', () => {
    const passed = setTo(40_000).decide({ month: '2026-11', spent: 50_000, memberIds: MEMBER_IDS }) as Budget;

    expect(passed.decide({ month: '2026-11', spent: 30_000, memberIds: MEMBER_IDS })).toBeNull();
    expect(passed.decide({ month: '2026-11', spent: 60_000, memberIds: MEMBER_IDS })).toBeNull();
    expect(passed.decide({ month: '2026-12', spent: 50_000, memberIds: MEMBER_IDS })).not.toBeNull();
  });

  it('is removed by the owner alone, keeps the months it passed, and decides nothing while removed', () => {
    const passed = setTo(40_000).decide({ month: '2026-11', spent: 50_000, memberIds: MEMBER_IDS }) as Budget;

    expect(passed.unset({ removedBy: 'ben', members: MEMBERS }).isFailure()).toBe(true);
    const removed = passed.unset({ removedBy: 'ana', members: MEMBERS });
    expect(removed.isSuccess()).toBe(true);
    const gone = removed.data as Budget;

    expect(gone.toSnapshot()).toMatchObject({ amount: null, passedMonths: ['2026-11'] });
    expect(gone.decide({ month: '2026-12', spent: 90_000, memberIds: MEMBER_IDS })).toBeNull();
    expect(gone.unset({ removedBy: 'ana', members: MEMBERS }).isFailure()).toBe(true);

    // Setting it again does not tell the month it already passed a second time.
    const again = setTo(30_000, gone);
    expect(again.decide({ month: '2026-11', spent: 50_000, memberIds: MEMBER_IDS })).toBeNull();
    expect(again.decide({ month: '2026-12', spent: 50_000, memberIds: MEMBER_IDS })).not.toBeNull();
  });

  it('reads back from a snapshot as it was stored, and records nothing', () => {
    const snapshot = { ...setTo(40_000).toSnapshot(), passedMonths: ['2026-10', '2026-11'], version: 3 };

    const budget = Budget.fromSnapshot(snapshot);

    expect(budget.toSnapshot()).toEqual(snapshot);
    expect(budget.pullDomainEvents()).toEqual([]);
    expect(() => Budget.fromSnapshot({ ...snapshot, category: 'sweets' as never })).toThrow('Corrupted budget');
  });
});
