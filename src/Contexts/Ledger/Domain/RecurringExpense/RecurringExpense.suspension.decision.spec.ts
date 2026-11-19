import { RecurringExpense } from './RecurringExpense';
import { decideSetUpRecurringExpense, decideSweepRecurringExpense } from './RecurringExpense.decision';

/** Request 34: a suspended payer sets up no recurring expense, and the background job records none for it: its days wait. */
const at = (day: string) => new Date(`${day}T12:00:00Z`);
const split = { kind: 'equal' as const, memberIds: ['ada', 'grace'] };
const recurring = RecurringExpense.setUp({
  groupId: 'flat',
  paidBy: 'ada',
  description: 'Rent',
  amount: 100,
  startsOn: '2026-09-05',
  split,
  category: 'other',
}).toSnapshot();

describe('a suspended payer and its recurring expenses (request 34)', () => {
  it('refuses to set up a recurring expense by a suspended payer, by the one name, before anything else is checked', () => {
    const refused = decideSetUpRecurringExpense(
      { archived: false, suspended: true, memberIds: ['ada', 'grace'] },
      { description: '', amount: 0, startsOn: '2020-01-01', split, payer: 'ada' },
      at('2026-11-18'),
    );
    expect(refused.isFailure() && refused.error.type).toBe('AccountSuspended');
  });

  it('records no day for a suspended payer, and leaves its next day where it is, so the days wait', () => {
    const waiting = decideSweepRecurringExpense(
      { archived: false, suspended: true, recurring, memberIds: ['ada', 'grace'] },
      undefined,
      at('2026-11-18'),
    );
    expect(waiting.data!.state).toEqual({ kind: 'due', days: [] });
  });

  it('records every day that came once the payer is reinstated', () => {
    const reinstated = decideSweepRecurringExpense(
      { archived: false, suspended: false, recurring, memberIds: ['ada', 'grace'] },
      undefined,
      at('2026-11-18'),
    );
    expect(reinstated.data!.state).toEqual({ kind: 'due', days: ['2026-09-05', '2026-10-05', '2026-11-05'] });
  });
});
