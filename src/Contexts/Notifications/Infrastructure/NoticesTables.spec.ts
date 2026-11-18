import { PostgresDatabase, closeDatabases } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { randomBytes } from 'crypto';

import { Id } from '@Architecture/Domain';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { PostgresNoticeReadModels } from '@Contexts/Notifications/Infrastructure/PostgresNoticeReadModels';
import { PostgresNoticeRepository } from '@Contexts/Notifications/Infrastructure/PostgresNoticeRepository';

describe('the notices table (ADR 10)', () => {
  afterAll(closeDatabases);

  it('reads a reminder as its own kind, for what is owed, with no expense', async () => {
    const database = new PostgresDatabase(
      process.env.DATABASE_URL as string,
      `notices_${randomBytes(6).toString('hex')}`,
    );
    const reminder = Notice.remind({
      recipient: new Id('cy'),
      groupId: new Id('flat'),
      amount: 2500,
      now: new Date('2026-03-17T09:00:00.000Z'),
    });
    const repository = new PostgresNoticeRepository(database);
    const readModels = new PostgresNoticeReadModels(database);
    await database.prepare();
    await repository.save(reminder.data as Notice);

    const [read] = await readModels.ofRecipient('cy');
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
