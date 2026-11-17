import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Id } from '@Architecture/Domain';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { createNoticesTables } from '@Contexts/Notifications/Infrastructure/NoticesTables';
import { SqliteNoticeReadModels } from '@Contexts/Notifications/Infrastructure/SqliteNoticeReadModels';
import { SqliteNoticeRepository } from '@Contexts/Notifications/Infrastructure/SqliteNoticeRepository';

describe('the notices table (ADR 10)', () => {
  it('keeps the notices of a file made before reminders, as expenses, in their order', async () => {
    const database = new SqliteDatabase(':memory:');
    database.exec(`CREATE TABLE notices (
      id TEXT PRIMARY KEY,
      recipient TEXT NOT NULL,
      group_id TEXT NOT NULL,
      expense_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    )`);
    database.exec(`INSERT INTO notices VALUES
      ('n1', 'cy', 'flat', 'rent', 300, '2026-03-10T09:00:00.000Z'),
      ('n2', 'cy', 'flat', 'milk', 40, '2026-03-10T09:00:00.000Z')`);

    createNoticesTables(database);

    expect(await new SqliteNoticeReadModels(database).ofRecipient('cy')).toEqual([
      { id: 'n2', kind: 'expense', groupId: 'flat', expenseId: 'milk', amount: 40, at: '2026-03-10T09:00:00.000Z' },
      { id: 'n1', kind: 'expense', groupId: 'flat', expenseId: 'rent', amount: 300, at: '2026-03-10T09:00:00.000Z' },
    ]);
  });

  it('reads a reminder as its own kind, for what is owed, with no expense', async () => {
    const database = new SqliteDatabase(':memory:');
    const reminder = Notice.remind({
      recipient: new Id('cy'),
      groupId: new Id('flat'),
      amount: 2500,
      now: new Date('2026-03-17T09:00:00.000Z'),
    });
    await new SqliteNoticeRepository(database).save(reminder.data as Notice);

    const [read] = await new SqliteNoticeReadModels(database).ofRecipient('cy');
    expect(read).toEqual({
      id: (reminder.data as Notice)._id.value,
      kind: 'reminder',
      groupId: 'flat',
      amount: 2500,
      at: '2026-03-17T09:00:00.000Z',
    });
    expect(read).not.toHaveProperty('expenseId');
  });
});
