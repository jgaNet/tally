import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { DebtWatch } from '@Contexts/Notifications/Domain/Debt/DebtWatch';
import { IDebtWatchRepository, NotedDebt } from '@Contexts/Notifications/Domain/Debt/Ports/IDebtWatchRepository';
import { DEBT_WATCH_STATEMENTS } from '@Contexts/Notifications/Infrastructure/notices.schema';

interface WatchRow {
  id: string;
  group_id: string;
  member_id: string;
  noted_since: string | null;
  last_reminded: string | null;
  version: number;
}

/**
 * The debt watches over the PostgreSQL database (ADR 12). A save stores version + 1 only where the stored version is the one the
 * watch was read at, so two runs that decide on one member at once cannot both win: the one that loses gets a
 * ConcurrencyConflictException, re-reads and re-decides (the sweep's retry).
 */
export class PostgresDebtWatchRepository implements IDebtWatchRepository {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(DEBT_WATCH_STATEMENTS);
  }

  async findByMember(groupId: Id, memberId: Id): Promise<DebtWatch | null> {
    const row = await this.database.connection.row<WatchRow>(
      `SELECT id, group_id, member_id, noted_since, last_reminded, version
         FROM notifications_debt_watches WHERE group_id = ? AND member_id = ?`,
      groupId.value,
      memberId.value,
    );
    if (!row) return null;
    return DebtWatch.fromSnapshot(
      {
        id: row.id,
        groupId: row.group_id,
        memberId: row.member_id,
        notedSince: row.noted_since,
        lastReminded: row.last_reminded,
      },
      Number(row.version),
    );
  }

  async save(watch: DebtWatch): Promise<IResult> {
    const { connection } = this.database;
    const { id, notedSince, lastReminded, groupId, memberId } = watch.toSnapshot();
    if (watch.version === 0) {
      const { changes } = await connection.run(
        `INSERT INTO notifications_debt_watches (id, group_id, member_id, noted_since, last_reminded, version)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT DO NOTHING`,
        id,
        groupId,
        memberId,
        notedSince,
        lastReminded,
      );
      if (changes === 0) return conflict(groupId, memberId);
    } else {
      const { changes } = await connection.run(
        `UPDATE notifications_debt_watches
            SET noted_since = ?, last_reminded = ?, version = version + 1
          WHERE id = ? AND version = ?`,
        notedSince,
        lastReminded,
        id,
        watch.version,
      );
      if (changes === 0) return conflict(groupId, memberId);
    }
    return Result.ok();
  }

  notedMembers(): Promise<NotedDebt[]> {
    return this.database.exclusive(connection =>
      connection.rows<NotedDebt>(
        'SELECT group_id AS "groupId", member_id AS "memberId" FROM notifications_debt_watches WHERE noted_since IS NOT NULL',
      ),
    );
  }
}

function conflict(groupId: string, memberId: string): IResult {
  return Result.fail(
    new ConcurrencyConflictException('Notifications', 'The debt watch of the member changed since it was read', {
      groupId,
      memberId,
    }),
  );
}
