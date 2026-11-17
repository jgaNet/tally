import { describe, expect, it, jest } from '@jest/globals';

import { ExecutionContext } from '@Architecture/Application';
import { EventBus } from '@Architecture/Application/EventBus';
import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Expense';
import { ExpenseRecordedHandler } from '@Contexts/Ledger/Application/Events/ExpenseRecordedHandler';
import { ExpenseRecordedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/ExpenseIntegrationEvents';

describe('ExpenseRecordedHandler', () => {
  it('tells the other contexts the expense with its payer and its shares, as ExpenseRecorded', async () => {
    const eventBus = { connect: jest.fn(), publish: jest.fn(), subscribe: jest.fn() } as unknown as EventBus;
    const context = new ExecutionContext({ traceId: 'trace', eventBus, auth: {} });

    const result = await new ExpenseRecordedHandler().execute(
      ExpenseRecordedEvent.set({
        expenseId: 'expense-1',
        groupId: 'group-1',
        paidBy: 'bob',
        amount: 900,
        splitKind: 'equal',
        shares: [
          { memberId: 'bob', amount: 300 },
          { memberId: 'cy', amount: 300 },
          { memberId: 'dee', amount: 300 },
        ],
        at: '2026-11-17T10:00:00.000Z',
      }),
      context,
    );

    expect(result.isSuccess()).toBe(true);
    const calls = (eventBus.publish as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1);
    const published = calls[0][0] as ExpenseRecordedIntegrationEvent;
    expect(published).toBeInstanceOf(ExpenseRecordedIntegrationEvent);
    expect(published.payload).toEqual({
      expenseId: 'expense-1',
      groupId: 'group-1',
      paidBy: 'bob',
      shares: [
        { memberId: 'bob', amount: 300 },
        { memberId: 'cy', amount: 300 },
        { memberId: 'dee', amount: 300 },
      ],
    });
  });
});
