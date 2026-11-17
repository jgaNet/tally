import { jest } from '@jest/globals';

import { EventBus, ExecutionContext } from '@Architecture/Application';
import { Role } from '@SharedKernel/Domain';

import { RecordExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/RecordExpense/RecordExpenseCommandEvent';
import { RecordExpenseCommandHandler } from '@Contexts/Ledger/Application/Commands/RecordExpense/RecordExpenseCommandHandler';
import {
  InMemoryBalances,
  InMemoryBalanceStore,
  InMemoryExpenseRepository,
  InMemoryExpenseStore,
  InMemoryGroupMembers,
} from '@Contexts/Ledger/Infrastructure/InMemoryExpenses';

const eventBus = { connect: jest.fn(), publish: jest.fn(), subscribe: jest.fn() } as EventBus;
const at = new Date('2026-03-10T10:00:00.000Z');
const signedInAs = (subjectId: string) =>
  new ExecutionContext({ traceId: 'trace', eventBus, auth: { subjectId, role: Role.USER } });
const anonymous = () => new ExecutionContext({ traceId: 'trace', eventBus, auth: { role: Role.GUEST } });

const setup = () => {
  const store: InMemoryExpenseStore = new Map();
  const balanceStore: InMemoryBalanceStore = new Map();
  const handler = new RecordExpenseCommandHandler(
    new InMemoryExpenseRepository(store),
    new InMemoryGroupMembers(new Map([['flat', ['alice', 'bob']]])),
    () => at,
    new InMemoryBalances(balanceStore),
  );
  return { store, balanceStore, handler };
};

const groceries = {
  groupId: 'flat',
  description: 'Groceries',
  amount: 1000,
  date: '2026-03-10',
  split: { kind: 'equal' as const, members: ['alice', 'bob'] },
};

describe('RecordExpense', () => {
  it('may not be asked by anyone who is not signed in', () => {
    const { handler } = setup();

    expect(handler.anyoneMayAsk(RecordExpenseCommandEvent.set(groceries))).toBe(false);
  });

  it('records the expense with the caller as its payer, and answers its id', async () => {
    const { handler, store } = setup();

    const result = await handler.execute(RecordExpenseCommandEvent.set(groceries), signedInAs('alice'));

    expect(result.isSuccess()).toBe(true);
    expect(store.get(result.data as string)).toMatchObject({
      groupId: 'flat',
      paidBy: 'alice',
      shares: [
        { memberId: 'alice', amount: 500 },
        { memberId: 'bob', amount: 500 },
      ],
    });
  });

  it('counts the expense into the balances: the payer is owed the amount, each member owes their share', async () => {
    const { handler, balanceStore } = setup();

    await handler.execute(RecordExpenseCommandEvent.set(groceries), signedInAs('alice'));

    expect(Object.fromEntries(balanceStore.get('flat') ?? [])).toEqual({ alice: 500, bob: -500 });
  });

  it('refuses a caller who is not a member of the group, as if the group did not exist', async () => {
    const { handler, store, balanceStore } = setup();

    const result = await handler.execute(RecordExpenseCommandEvent.set(groceries), signedInAs('carl'));

    expect(result.isFailure() && result.error.type).toBe('NotFound');
    expect(store.size).toBe(0);
    expect(balanceStore.size).toBe(0);
  });

  it('refuses a split with a stranger, and keeps nothing, not even in the balances', async () => {
    const { handler, store, balanceStore } = setup();

    const result = await handler.execute(
      RecordExpenseCommandEvent.set({ ...groceries, split: { kind: 'equal', members: ['alice', 'carl'] } }),
      signedInAs('alice'),
    );

    expect(result.isFailure() && result.error.type).toBe('NotAMemberOfTheGroup');
    expect(store.size).toBe(0);
    expect(balanceStore.size).toBe(0);
  });

  it('records an expense split by exact amounts, and by shares, as the split it gives', async () => {
    const { handler, store } = setup();

    const exact = await handler.execute(
      RecordExpenseCommandEvent.set({
        ...groceries,
        split: {
          kind: 'exact',
          amounts: [
            { memberId: 'alice', amount: 300 },
            { memberId: 'bob', amount: 700 },
          ],
        },
      }),
      signedInAs('alice'),
    );
    const shares = await handler.execute(
      RecordExpenseCommandEvent.set({
        ...groceries,
        amount: 1001,
        split: {
          kind: 'shares',
          shares: [
            { memberId: 'alice', shares: 2 },
            { memberId: 'bob', shares: 1 },
          ],
        },
      }),
      signedInAs('bob'),
    );

    expect(store.get(exact.data as string)).toMatchObject({
      splitKind: 'exact',
      shares: [
        { memberId: 'alice', amount: 300 },
        { memberId: 'bob', amount: 700 },
      ],
    });
    expect(store.get(shares.data as string)).toMatchObject({
      splitKind: 'shares',
      shares: [
        { memberId: 'alice', amount: 667 },
        { memberId: 'bob', amount: 334 },
      ],
    });
  });

  it('refuses exact amounts that do not add up, and keeps nothing', async () => {
    const { handler, store, balanceStore } = setup();

    const result = await handler.execute(
      RecordExpenseCommandEvent.set({
        ...groceries,
        split: {
          kind: 'exact',
          amounts: [
            { memberId: 'alice', amount: 300 },
            { memberId: 'bob', amount: 600 },
          ],
        },
      }),
      signedInAs('alice'),
    );

    expect(result.isFailure() && result.error.type).toBe('ShareAmountsDoNotAddUp');
    expect(store.size).toBe(0);
    expect(balanceStore.size).toBe(0);
  });

  it('refuses a caller who is not signed in', async () => {
    const { handler } = setup();

    const result = await handler.execute(RecordExpenseCommandEvent.set(groceries), anonymous());

    expect(result.isFailure() && result.error.type).toBe('NotAllowed');
  });
});
