import { Id } from '@Architecture/Domain';
import { Budget, MAX_BUDGET } from '@Contexts/Ledger/Domain/Budget/Budget';

const at = new Date('2030-01-10T00:00:00.000Z');
const groupId = Id.generate();
const owner = Id.generate();

function establish(amount = 100) {
  const created = Budget.establish({ groupId, category: 'groceries', amount, byOwner: true, at });
  if (created.isFailure()) throw new Error('the budget was refused');
  return created.data;
}

describe('Budget (request 24)', () => {
  it('is set by the owner only, with an amount from 1 to 100 000 000', () => {
    expect(Budget.establish({ groupId, category: 'rent', amount: 5, byOwner: false, at }).isFailure()).toBe(true);
    expect(Budget.establish({ groupId, category: 'rent', amount: 0, byOwner: true, at }).isFailure()).toBe(true);
    expect(Budget.establish({ groupId, category: 'rent', amount: MAX_BUDGET + 1, byOwner: true, at }).isFailure()).toBe(
      true,
    );
    expect(Budget.establish({ groupId, category: 'rent', amount: MAX_BUDGET, byOwner: true, at }).isFailure()).toBe(
      false,
    );
  });

  it('passes a month once, only when its spending is more than the budget', () => {
    const budget = establish(100);
    expect(budget.judge({ month: '2030-01', spent: 100, memberIds: [owner], at })).toBe(budget);

    const passed = budget.judge({ month: '2030-01', spent: 101, memberIds: [owner], at });
    expect(passed).not.toBe(budget);
    expect(passed.passedMonths).toEqual(['2030-01']);
    expect(passed.judge({ month: '2030-01', spent: 400, memberIds: [owner], at })).toBe(passed);
    expect(passed.judge({ month: '2030-02', spent: 150, memberIds: [owner], at }).passedMonths).toEqual([
      '2030-01',
      '2030-02',
    ]);
  });

  it('keeps the months it passed when removed, and is told of no month while removed', () => {
    const passed = establish(100).judge({ month: '2030-01', spent: 101, memberIds: [owner], at });
    const removed = passed.lift({ byOwner: true, at });
    if (removed.isFailure()) throw new Error('the budget was refused');
    expect(removed.data.active).toBe(false);
    expect(removed.data.judge({ month: '2030-02', spent: 999, memberIds: [owner], at })).toBe(removed.data);

    const again = removed.data.amend({ byOwner: true, amount: 50, at });
    if (again.isFailure()) throw new Error('the budget was refused');
    expect(again.data.active).toBe(true);
    expect(again.data.passedMonths).toEqual(['2030-01']);
    expect(again.data.judge({ month: '2030-01', spent: 60, memberIds: [owner], at })).toBe(again.data);
  });
});
