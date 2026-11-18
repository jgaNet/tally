import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { DebtWatch } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';
import { IDebtWatchRepository } from '@Contexts/Notifications/Domain/DebtWatch/Ports/IDebtWatchRepository';
import { createDebtWatchTables } from '@Contexts/Notifications/Infrastructure/DebtWatchTables';

interface Row {
  id: string;
  group_id: string;
  member_id: string;
  noted_since: string | null;
  reminded_at: string | null;
  version: number;
}

/**
 * The debt watches, in the application's file. A watch is saved at the version it was read at: two sweeps that read the same watch
 * cannot both save it, and the one that loses is a conflict, which its sweep answers by reading the watch again.
 */
export class PostgresDebtWatchRepository implements IDebtWatchRepository {
  constructor(private database: PostgresDatabase) {
    createDebtWatchTables(database);
  }

  async find(groupId: string, memberId: string): Promise<DebtWatch | null> {
    const row = await this.database.get<Row>(
      'SELECT id, group_id, member_id, noted_since, reminded_at, version FROM debt_watches WHERE group_id = ? AND member_id = ?',
      groupId,
      memberId,
    );
    return row ? toWatch(row) : null;
  }

  async findNoted(): Promise<DebtWatch[]> {
    return this.database.exclusive(async () =>
      (
        await this.database.all<Row>(
          'SELECT id, group_id, member_id, noted_since, reminded_at, version FROM debt_watches WHERE noted_since IS NOT NULL',
        )
      ).map(toWatch),
    );
  }

  async save(watch: DebtWatch): Promise<IResult> {
    const since = watch.notedSince?.toISOString() ?? null;
    const reminded = watch.lastReminded?.toISOString() ?? null;
    if (watch.version === 0) {
      const inserted = await this.database.run(
        'INSERT INTO debt_watches (id, group_id, member_id, noted_since, reminded_at, version) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT DO NOTHING',
        watch._id.value,
        watch.groupId.value,
        watch.memberId.value,
        since,
        reminded,
      );
      if (!inserted) return conflict(watch);
    } else {
      const changed = await this.database.run(
        'UPDATE debt_watches SET noted_since = ?, reminded_at = ?, version = ? WHERE id = ? AND version = ?',
        since,
        reminded,
        watch.version + 1,
        watch._id.value,
        watch.version,
      );
      if (!changed) return conflict(watch);
    }
    return Result.ok();
  }
}

const toWatch = (row: Row): DebtWatch =>
  DebtWatch.fromSnapshot({
    id: row.id,
    groupId: row.group_id,
    memberId: row.member_id,
    notedSince: row.noted_since,
    remindedAt: row.reminded_at,
    version: row.version,
  });

const conflict = (watch: DebtWatch): IResult =>
  Result.fail(
    new ConcurrencyConflictException('Notifications', 'The debt watch has changed', {
      groupId: watch.groupId.value,
      memberId: watch.memberId.value,
    }),
  );
