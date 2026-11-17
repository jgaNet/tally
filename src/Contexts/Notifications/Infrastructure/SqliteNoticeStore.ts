import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { INoticeReads, NoticeView } from '@Contexts/Notifications/Application/INoticeReads';
import { INoticeStore } from '@Contexts/Notifications/Application/INoticeStore';
import { Notice, NoticeKind } from '@Contexts/Notifications/Domain/Notice/Notice';

/**
 * The notices' table (requests 17 and 18): one row per notice, its kind, its recipient, what it is about and when it was made. A reminder
 * names no expense, so its `expense_id` is null. `seq` keeps the order they were made in, so two made at the same instant are listed the
 * latest first as well.
 */
export const notificationsTablesSchema = [
  `CREATE TABLE IF NOT EXISTS notices (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     recipient_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('expense', 'reminder')),
     group_id TEXT NOT NULL,
     expense_id TEXT,
     amount INTEGER NOT NULL,
     at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS notices_by_recipient ON notices (recipient_id, at, seq)`,
];

interface NoticeRow {
  id: string;
  kind: NoticeKind;
  group_id: string;
  expense_id: string | null;
  amount: number;
  at: string;
}

/**
 * The notices in SQLite. `add` writes inside the reaction's transaction (on the writer), and `listFor` reads what is committed.
 */
export class SqliteNoticeStore implements INoticeStore, INoticeReads {
  constructor(private readonly database: SqliteDatabase) {}

  async add(notice: Notice): Promise<void> {
    const snapshot = notice.toSnapshot();
    this.database.writer
      .prepare(
        'INSERT INTO notices (id, recipient_id, kind, group_id, expense_id, amount, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        snapshot.id,
        snapshot.recipientId,
        snapshot.kind,
        snapshot.groupId,
        snapshot.expenseId ?? null,
        snapshot.amount,
        snapshot.at,
      );
  }

  async listFor(recipientId: string): Promise<NoticeView[]> {
    const rows = this.database.read(db =>
      db
        .prepare(
          'SELECT id, kind, group_id, expense_id, amount, at FROM notices WHERE recipient_id = ? ORDER BY at DESC, seq DESC',
        )
        .all(recipientId),
    ) as unknown as NoticeRow[];
    return rows.map(row => ({
      id: row.id,
      kind: row.kind,
      groupId: row.group_id,
      ...(row.expense_id !== null && { expenseId: row.expense_id }),
      amount: row.amount,
      at: row.at,
    }));
  }
}
