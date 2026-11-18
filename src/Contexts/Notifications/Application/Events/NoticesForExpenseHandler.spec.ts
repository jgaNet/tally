import { describe, expect, it } from '@jest/globals';

import { ExecutionContext } from '@Architecture/Application';
import { EventBus } from '@Architecture/Application/EventBus';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';
import { NoticesForExpenseHandler } from '@Contexts/Notifications/Application/Events/NoticesForExpenseHandler';
import { INoticeStore } from '@Contexts/Notifications/Application/INoticeStore';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { MemoryNoticePreferences } from '@Contexts/Notifications/Application/NoticePreferences.spec-helper';

class RecordingStore implements INoticeStore {
  added: Notice[] = [];
  async add(notice: Notice): Promise<void> {
    this.added.push(notice);
  }
}

const noBus = { connect() {}, publish() {}, subscribe() {} } as unknown as EventBus;
const NOW = new Date('2026-11-17T10:00:00.000Z');

describe('NoticesForExpenseHandler', () => {
  it('makes one notice for each member of the split but the payer, with their share', async () => {
    const store = new RecordingStore();
    const handler = new NoticesForExpenseHandler(store, new MemoryNoticePreferences(), () => NOW);
    const context = new ExecutionContext({ traceId: 'trace', eventBus: noBus, auth: {} });

    const result = await handler.execute(
      ExpenseRecordedIntegrationEvent.set({
        expenseId: 'expense-1',
        groupId: 'group-1',
        paidBy: 'bob',
        shares: [
          { memberId: 'bob', amount: 300 },
          { memberId: 'cy', amount: 200 },
          { memberId: 'dee', amount: 400 },
        ],
      }),
      context,
    );

    expect(result.isSuccess()).toBe(true);
    expect(store.added.map(notice => notice.toSnapshot())).toEqual([
      {
        id: expect.any(String),
        recipientId: 'cy',
        kind: 'expense',
        groupId: 'group-1',
        expenseId: 'expense-1',
        amount: 200,
        at: '2026-11-17T10:00:00.000Z',
      },
      {
        id: expect.any(String),
        recipientId: 'dee',
        kind: 'expense',
        groupId: 'group-1',
        expenseId: 'expense-1',
        amount: 400,
        at: '2026-11-17T10:00:00.000Z',
      },
    ]);
  });

  it('makes no notice for an expense its payer alone is in', async () => {
    const store = new RecordingStore();
    const context = new ExecutionContext({ traceId: 'trace', eventBus: noBus, auth: {} });

    await new NoticesForExpenseHandler(store, new MemoryNoticePreferences(), () => NOW).execute(
      ExpenseRecordedIntegrationEvent.set({
        expenseId: 'expense-2',
        groupId: 'group-1',
        paidBy: 'bob',
        shares: [{ memberId: 'bob', amount: 500 }],
      }),
      context,
    );

    expect(store.added).toEqual([]);
  });
});
