import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { migrateNotices } from '@Contexts/Notifications/Infrastructure/notices.schema';

/** The table request 17 made: an expense's notice only, with `expense_id` required. */
const REQUEST_17_TABLE = `CREATE TABLE notifications_notices (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expense')),
  amount INTEGER NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (expense_id, member_id)
)`;

describe('notices.schema: a file made by request 17 keeps its notices and takes reminders (request 18)', () => {
  it('rebuilds the notices table once, keeping its rows, and then stores a reminder with no expense', () => {
    const database = new SqliteDatabase(':memory:');
    database.connection.exec(REQUEST_17_TABLE);
    database.connection
      .prepare(
        `INSERT INTO notifications_notices VALUES ('n1', 'alice', 'g1', 'e1', 'expense', 500, '2030-01-01T00:00:00.000Z')`,
      )
      .run();

    migrateNotices(database);
    migrateNotices(database);

    const rows = database.connection.prepare('SELECT id, expense_id AS expenseId FROM notifications_notices').all();
    expect(rows).toEqual([{ id: 'n1', expenseId: 'e1' }]);
    database.connection
      .prepare(
        `INSERT INTO notifications_notices VALUES ('n2', 'alice', 'g1', NULL, 'reminder', 2500, '2030-01-08T00:00:00.000Z')`,
      )
      .run();
    expect(database.connection.prepare('SELECT COUNT(*) AS n FROM notifications_notices').get()).toEqual({ n: 2 });
    database.close();
  });
});
