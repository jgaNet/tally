import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { PostgresNoticeQueries } from '@Contexts/Notifications/Infrastructure/Queries/PostgresNoticeQueries';
import { PostgresNoticeRepository } from '@Contexts/Notifications/Infrastructure/Repositories/PostgresNoticeRepository';

/**
 * What a person reads of a reminder (request 18): its kind, its group, what is still owed, and no expense: the answer has no
 * `expenseId` at all, where an expense's notice has one.
 */
describe('PostgresNoticeQueries (request 18)', () => {
  const databases: PostgresDatabase[] = [];

  afterAll(async () => {
    for (const database of databases) await database.close();
  });

  it('answers a reminder with its amount and no expense, and an expense notice with its expense', async () => {
    const database = new PostgresDatabase(process.env.DATABASE_URL!);
    databases.push(database);
    const repository = new PostgresNoticeRepository(database);
    const queries = new PostgresNoticeQueries(database);
    await database.open();

    const at = new Date('2026-11-08T00:00:00.000Z');
    const reminder = Notice.remind({ currency: 'EUR', recipient: 'cy', groupId: 'house', amount: 2500, at });
    const expense = Notice.issue({ recipient: 'cy', groupId: 'house', expenseId: 'pizzas', amount: 333, at });
    if (reminder.isFailure() || expense.isFailure()) throw new Error('a notice is made');
    await repository.save(reminder.data);
    await repository.save(expense.data);

    const answers = await queries.ofRecipient('cy');
    const byKind = Object.fromEntries(answers.map(answer => [answer.kind, answer]));
    expect(byKind.reminder).toEqual({
      id: expect.any(String),
      kind: 'reminder',
      groupId: 'house',
      amount: 2500,
      at: at.toISOString(),
    });
    expect(byKind.reminder).not.toHaveProperty('expenseId');
    expect(byKind.expense).toEqual({
      id: expect.any(String),
      kind: 'expense',
      groupId: 'house',
      expenseId: 'pizzas',
      amount: 333,
      at: at.toISOString(),
    });
  });
});
