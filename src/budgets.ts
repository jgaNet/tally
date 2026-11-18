import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { CATEGORIES, isCategory, type Category } from './categories';
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
export function spentIn(db: DatabaseSync, groupId: string, category: string, month: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS spent FROM expenses
       WHERE group_id = ? AND category = ? AND substr(date, 1, 7) = ?`,
    )
    .get(groupId, category, month) as { spent: number };
  return row.spent;
}

/**
 * Notes that an expense of the group, in the category and on the day given, has been recorded or edited: when its month
 * then spends more than the category's budget, every member of the group is given a notice of kind `budget`, with the
 * category, the month, the budget and what the month spends. A month is noted once per category, so a later expense of
 * that month, however far it goes over, makes no other. It is called inside the write transaction of the expense, so
 * the notices exist exactly when the expense does.
 */
export function writeBudgetPassing(db: DatabaseSync, groupId: string, category: string, day: string, at: string): void {
  const budget = db.prepare('SELECT amount FROM budgets WHERE group_id = ? AND category = ?').get(groupId, category) as
    { amount: number } | undefined;
  if (budget === undefined) return;
  const month = monthOf(day);
  const spent = spentIn(db, groupId, category, month);
  if (spent <= budget.amount) return;
  const noted = db
    .prepare('INSERT OR IGNORE INTO budget_passings (group_id, category, month) VALUES (?, ?, ?)')
    .run(groupId, category, month);
  if (noted.changes === 0) return;
  const members = db
    .prepare('SELECT account_id FROM group_members WHERE group_id = ? AND left_at IS NULL')
    .all(groupId) as unknown as { account_id: string }[];
  const insert = db.prepare(
    `INSERT INTO notices (id, account_id, kind, group_id, expense_id, category, month, budget, amount, created_at)
     VALUES (?, ?, 'budget', ?, NULL, ?, ?, ?, ?, ?)`,
  );
  for (const member of members) {
    insert.run(randomUUID(), member.account_id, groupId, category, month, budget.amount, spent, at);
  }
}

/** The group's budgets, in the order of the categories, each with what the current month spends in it. */
export function listBudgetsOf(db: DatabaseSync, accountId: string, groupId: string): Budget[] {
  if (!findGroupOf(db, accountId, groupId)) throw new Refusal(404, 'NotFound', 'There is no such group.');
  const month = monthOf(todayUtc());
  const rows = db.prepare('SELECT category, amount FROM budgets WHERE group_id = ?').all(groupId) as unknown as {
    category: Category;
    amount: number;
  }[];
  return rows
    .map(row => ({
      category: row.category,
      amount: row.amount,
      spent: spentIn(db, groupId, row.category, month),
    }))
    .sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
}

/** The group, when the account is its owner. For a member who is not the owner the change is refused; for anyone else the group does not exist. */
function ownedGroup(db: DatabaseSync, accountId: string, groupId: string): void {
  const group = findGroupOf(db, accountId, groupId);
  if (!group) throw new Refusal(404, 'NotFound', 'There is no such group.');
  refuseIfArchived(db, groupId);
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
export function setBudget(
  db: DatabaseSync,
  accountId: string,
  groupId: string,
  category: string,
  amount: number,
): void {
  ownedGroup(db, accountId, groupId);
  checkCategory(category);
  if (amount < 1 || amount > BUDGET_MAX) {
    throw new Refusal(
      422,
      'InvalidAmount',
      `The budget must be from 1 to ${BUDGET_MAX}, in hundredths of the currency.`,
    );
  }
  // Setting a budget notes nothing: a month is noted when an expense of it is recorded or edited.
  db.prepare(
    `INSERT INTO budgets (group_id, category, amount) VALUES (?, ?, ?)
     ON CONFLICT (group_id, category) DO UPDATE SET amount = excluded.amount`,
  ).run(groupId, category, amount);
}

/** Removes the budget of the category. Only the owner of the group may. */
export function removeBudget(db: DatabaseSync, accountId: string, groupId: string, category: string): void {
  ownedGroup(db, accountId, groupId);
  checkCategory(category);
  const removed = db.prepare('DELETE FROM budgets WHERE group_id = ? AND category = ?').run(groupId, category);
  if (removed.changes === 0) throw new Refusal(404, 'NotFound', 'There is no such budget.');
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

export function registerBudgetRoutes(app: FastifyInstance, db: DatabaseSync): void {
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
    (request, reply) => {
      const accountId = requireCaller(db, request);
      setBudget(db, accountId, request.params.id, request.params.category, request.body.amount);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; category: string } }>('/groups/:id/budgets/:category', (request, reply) => {
    const accountId = requireCaller(db, request);
    removeBudget(db, accountId, request.params.id, request.params.category);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>(
    '/groups/:id/budgets',
    { schema: { response: { 200: { type: 'array', items: budgetSchema } } } },
    request => listBudgetsOf(db, requireCaller(db, request), request.params.id),
  );
}
