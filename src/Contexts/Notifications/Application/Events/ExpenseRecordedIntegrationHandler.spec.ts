import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';

import { ExpenseRecordedIntegrationHandler } from '@Contexts/Notifications/Application/Events/ExpenseRecordedIntegrationHandler';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INotices } from '@Contexts/Notifications/Domain/Notice/Ports/INotices';
import { NoticePreferences } from '@Contexts/Notifications/Domain/Preference/NoticePreferences';
import { INoticePreferences } from '@Contexts/Notifications/Domain/Preference/Ports/INoticePreferences';
import { Result } from '@Architecture/Domain';

/** The preferences of the people who turned expense notices off; everyone else has every kind on. */
class Preferences implements INoticePreferences {
  constructor(private readonly off: string[] = []) {}
  async get(accountId: string): Promise<NoticePreferences> {
    return NoticePreferences.fromSnapshot({
      id: `p-${accountId}`,
      version: 1,
      accountId,
      expense: !this.off.includes(accountId),
      reminder: true,
      budget: true,
    });
  }
  async save() {
    return Result.ok(undefined);
  }
}

/** A store with the real store's key: one notice per person and expense. */
class KeyedNotices implements INotices {
  readonly saved = new Map<string, Notice>();
  async save(notice: Notice): Promise<boolean> {
    const key = `${notice.accountId}/${notice.expenseId}`;
    if (this.saved.has(key)) return false;
    this.saved.set(key, notice);
    return true;
  }
}

const context = { afterCommit: () => undefined, eventBus: { publish: () => undefined } } as unknown as ExecutionContext;
const event = ExpenseRecordedIntegrationEvent.set({
  expenseId: 'e1',
  groupId: 'g1',
  paidBy: 'bob',
  shares: [
    { memberId: 'bob', amount: 400 },
    { memberId: 'cy', amount: 300 },
    { memberId: 'dee', amount: 300 },
  ],
}) as ExpenseRecordedIntegrationEvent;

describe('ExpenseRecordedIntegrationHandler', () => {
  it('issues a notice to each member of the split but the payer, with their share', async () => {
    const notices = new KeyedNotices();
    const handler = new ExpenseRecordedIntegrationHandler(
      notices,
      new Preferences(),
      () => new Date('2026-01-15T10:00:00Z'),
    );

    expect((await handler.execute(event, context)).isSuccess()).toBe(true);

    expect([...notices.saved.values()].map(notice => notice.toSnapshot())).toEqual([
      expect.objectContaining({
        accountId: 'cy',
        expenseId: 'e1',
        groupId: 'g1',
        amount: 300,
        at: '2026-01-15T10:00:00.000Z',
      }),
      expect.objectContaining({ accountId: 'dee', expenseId: 'e1', groupId: 'g1', amount: 300 }),
    ]);
  });

  it('makes no second notice when the fact is handed again', async () => {
    const notices = new KeyedNotices();
    const handler = new ExpenseRecordedIntegrationHandler(notices, new Preferences(), () => new Date());
    await handler.execute(event, context);
    await handler.execute(event, context);
    expect(notices.saved.size).toBe(2);
  });

  it('tells nobody who turned expense notices off, and tells the others as before', async () => {
    const notices = new KeyedNotices();
    const handler = new ExpenseRecordedIntegrationHandler(notices, new Preferences(['cy']), () => new Date());

    await handler.execute(event, context);

    expect([...notices.saved.values()].map(notice => notice.accountId)).toEqual(['dee']);
  });
});
