import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { CATEGORIES, isCategory, type Category } from './categories';
import type { Database, Queryable } from './database';
import { todayUtc } from './days';
import { findGroupOf, refuseIfArchived } from './groups';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

/** A budget's amount is from 1 to this, in hundredths of the group's currency, as an expense's is. */
const BUDGET_MAX = 100_000_000;

/** A budget of a group for a category, with what the current month spends in it. */
export interface Budget {
  category: Category;
  amount: number;
  spent: number;
}

/** The month of a day, as `YYYY-MM`. */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

/**
 * What the group's expenses of the category spend in the month, in hundredths of the group's currency: the sum of
 * their amounts, for the expenses whose date is in that month, in UTC. Expenses that are deleted are not kept, so none is left out.
 */
export async function spentIn(db: Queryable, groupId: string, category: string, month: string): Promise<number> {
  const row = await db.get<{ spent: number }>(
    `SELECT COALESCE(SUM(amount), 0) AS spent FROM expenses
     WHERE group_id = ? AND category = ? AND substr(date, 1, 7) = ?`,
    [groupId, category, month],
  );
  return row?.spent ?? 0;
}

/**
 * Notes that an expense of the group, in the category and on the day given, has been recorded or edited: when its month
 * then spends more than the category's budget, every member of the group is given a notice of kind `budget`, with the
 * category, the month, the budget and what the month spends. A month is noted once per category, so a later expense of
 * that month, however far it goes over, makes no other. It is called inside the write transaction of the expense, so
 * the notices exist exactly when the expense does.
 */
export async function writeBudgetPassing(
  db: Queryable,
  groupId: string,
  category: string,
  day: string,
  at: string,
): Promise<void> {
  const budget = await db.get<{ amount: number }>('SELECT amount FROM budgets WHERE group_id = ? AND category = ?', [
    groupId,
    category,
  ]);
  if (budget === undefined) return;
  const month = monthOf(day);
  const spent = await spentIn(db, groupId, category, month);
  if (spent <= budget.amount) return;
  const noted = await db.run(
    'INSERT INTO budget_passings (group_id, category, month) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    [groupId, category, month],
  );
  if (noted.changes === 0) return;
  const members = await db.all<{ account_id: string }>(
    'SELECT account_id FROM group_members WHERE group_id = ? AND left_at IS NULL',
    [groupId],
  );
  for (const member of members) {
    await db.run(
      `INSERT INTO notices (id, account_id, kind, group_id, expense_id, category, month, budget, amount, created_at)
       VALUES (?, ?, 'budget', ?, NULL, ?, ?, ?, ?, ?)`,
      [randomUUID(), member.account_id, groupId, category, month, budget.amount, spent, at],
    );
  }
}

/** The group's budgets, in the order of the categories, each with what the current month spends in it. */
export async function listBudgetsOf(db: Queryable, accountId: string, groupId: string): Promise<Budget[]> {
  if (!(await findGroupOf(db, accountId, groupId))) throw new Refusal(404, 'NotFound', 'There is no such group.');
  const month = monthOf(todayUtc());
  const rows = await db.all<{ category: Category; amount: number }>(
    'SELECT category, amount FROM budgets WHERE group_id = ?',
    [groupId],
  );
  const budgets: Budget[] = [];
  for (const row of rows) {
    budgets.push({
      category: row.category,
      amount: row.amount,
      spent: await spentIn(db, groupId, row.category, month),
    });
  }
  return budgets.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
}

/** The group, when the account is its owner. For a member who is not the owner the change is refused; for anyone else the group does not exist. */
async function ownedGroup(db: Queryable, accountId: string, groupId: string): Promise<void> {
  const group = await findGroupOf(db, accountId, groupId);
  if (!group) throw new Refusal(404, 'NotFound', 'There is no such group.');
  await refuseIfArchived(db, groupId);
  if (group.ownerId !== accountId) {
    throw new Refusal(403, 'NotAllowed', 'Only the owner of the group may set or remove its budgets.');
  }
}

function checkCategory(category: string): asserts category is Category {
  if (!isCategory(category)) {
    throw new Refusal(422, 'InvalidCategory', `The category must be one of ${CATEGORIES.join(', ')}.`);
  }
}

/** Sets the monthly budget of the category, replacing any budget it had. Only the owner of the group may. */
export async function setBudget(
  db: Database,
  accountId: string,
  groupId: string,
  category: string,
  amount: number,
): Promise<void> {
  // Setting a budget notes nothing: a month is noted when an expense of it is recorded or edited.
  await db.transaction(async tx => {
    await ownedGroup(tx, accountId, groupId);
    checkCategory(category);
    if (amount < 1 || amount > BUDGET_MAX) {
      throw new Refusal(
        422,
        'InvalidAmount',
        `The budget must be from 1 to ${BUDGET_MAX}, in hundredths of the currency.`,
      );
    }
    await tx.run(
      `INSERT INTO budgets (group_id, category, amount) VALUES (?, ?, ?)
       ON CONFLICT (group_id, category) DO UPDATE SET amount = excluded.amount`,
      [groupId, category, amount],
    );
  });
}

/** Removes the budget of the category. Only the owner of the group may. */
export async function removeBudget(db: Database, accountId: string, groupId: string, category: string): Promise<void> {
  await db.transaction(async tx => {
    await ownedGroup(tx, accountId, groupId);
    checkCategory(category);
    const removed = await tx.run('DELETE FROM budgets WHERE group_id = ? AND category = ?', [groupId, category]);
    if (removed.changes === 0) throw new Refusal(404, 'NotFound', 'There is no such budget.');
  });
}

const budgetSchema = {
  type: 'object',
  required: ['category', 'amount', 'spent'],
  properties: {
    category: { enum: [...CATEGORIES] },
    amount: { type: 'integer' },
    spent: { type: 'integer', minimum: 0 },
  },
};

export function registerBudgetRoutes(app: FastifyInstance, db: Database): void {
  app.put<{ Params: { id: string; category: string }; Body: { amount: number } }>(
    '/groups/:id/budgets/:category',
    {
      schema: {
        body: {
          type: 'object',
          required: ['amount'],
          properties: { amount: { type: 'integer' } },
        },
      },
    },
    async (request, reply) => {
      const accountId = await requireCaller(db, request);
      await setBudget(db, accountId, request.params.id, request.params.category, request.body.amount);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; category: string } }>('/groups/:id/budgets/:category', async (request, reply) => {
    const accountId = await requireCaller(db, request);
    await removeBudget(db, accountId, request.params.id, request.params.category);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>(
    '/groups/:id/budgets',
    { schema: { response: { 200: { type: 'array', items: budgetSchema } } } },
    async request => listBudgetsOf(db, await requireCaller(db, request), request.params.id),
  );
}
