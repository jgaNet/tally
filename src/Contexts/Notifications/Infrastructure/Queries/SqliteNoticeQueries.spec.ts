import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { SqliteNoticeQueries } from '@Contexts/Notifications/Infrastructure/Queries/SqliteNoticeQueries';
import { SqliteNoticeRepository } from '@Contexts/Notifications/Infrastructure/Repositories/SqliteNoticeRepository';

/**
 * What a person reads of a reminder (request 18): its kind, its group, what is still owed, and no expense: the answer has no
 * `expenseId` at all, where an expense's notice has one.
 */
describe('SqliteNoticeQueries (request 18)', () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tally-notice-queries-'));
    file = join(directory, 'tally.db');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('answers a reminder with its amount and no expense, and an expense notice with its expense', async () => {
    const database = new SqliteDatabase(file);
    const repository = new SqliteNoticeRepository(database);
    const at = new Date('2026-11-08T00:00:00.000Z');
    const reminder = Notice.remind({ recipient: 'cy', groupId: 'house', amount: 2500, at });
    const expense = Notice.issue({ recipient: 'cy', groupId: 'house', expenseId: 'pizzas', amount: 333, at });
    if (reminder.isFailure() || expense.isFailure()) throw new Error('a notice is made');
    await repository.save(reminder.data);
    await repository.save(expense.data);

    const answers = await new SqliteNoticeQueries(new SqliteDatabase(file)).ofRecipient('cy');
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
