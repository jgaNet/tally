import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IOperationRecords } from '@Contexts/Tracker/Application/Ports/IOperationRecords';
import { OperationRecord } from '@Contexts/Tracker/Application/ReadModel/OperationRecord';

/**
 * The operations in the SQLite file, so that a restarted server, or another one on the same
 * file, answers an operation a client was given. A record is written on its own, outside the
 * transaction of the command it reports (an operation refused by a rollback is still recorded).
 */
export class SqliteOperationRecords implements IOperationRecords {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate([
      `CREATE TABLE IF NOT EXISTS operation_records (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         id TEXT NOT NULL UNIQUE,
         trace_id TEXT NOT NULL,
         record TEXT NOT NULL
       )`,
      'CREATE INDEX IF NOT EXISTS operation_records_trace ON operation_records (trace_id)',
    ]);
  }

  async save(record: OperationRecord): Promise<void> {
    await this.database.exclusive(connection =>
      connection
        .prepare(
          `INSERT INTO operation_records (id, trace_id, record) VALUES (?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET record = excluded.record`,
        )
        .run(record.id, record.traceId, JSON.stringify(record)),
    );
  }

  async findById(id: string): Promise<OperationRecord | null> {
    const row = await this.database.exclusive(
      connection => connection.prepare('SELECT record FROM operation_records WHERE id = ?').get(id) as unknown,
    );
    return row ? revive((row as { record: string }).record) : null;
  }

  async findAll(): Promise<OperationRecord[]> {
    const rows = await this.database.exclusive(
      connection => connection.prepare('SELECT record FROM operation_records ORDER BY seq').all() as unknown,
    );
    return (rows as { record: string }[]).map(row => revive(row.record));
  }

  async findByTraceId(traceId: string): Promise<OperationRecord[]> {
    const rows = await this.database.exclusive(
      connection =>
        connection
          .prepare('SELECT record FROM operation_records WHERE trace_id = ? ORDER BY seq')
          .all(traceId) as unknown,
    );
    return (rows as { record: string }[]).map(row => revive(row.record));
  }
}

function revive(json: string): OperationRecord {
  const record = JSON.parse(json);
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    finishedAt: record.finishedAt ? new Date(record.finishedAt) : undefined,
  };
}
