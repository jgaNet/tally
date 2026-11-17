import { OperationStatus } from '@Architecture/Application';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IOperationRecords } from '@Contexts/Tracker/Application/Ports/IOperationRecords';
import { OperationRecord } from '@Contexts/Tracker/Application/ReadModel/OperationRecord';

/**
 * The operation records over the application's SQLite file, so that an operation a client was answered with
 * (`202 { operationId }`) is still there to be followed after the server restarts. Writes and reads take the
 * file's turn: a record is written by the bus, outside any transaction of a command.
 */
export class SqliteOperationRecords implements IOperationRecords {
  constructor(private database: SqliteDatabase) {
    database.connection.exec(`
      CREATE TABLE IF NOT EXISTS operation_records (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        subject_id TEXT,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS operation_records_trace ON operation_records (trace_id);
    `);
  }

  async save(record: OperationRecord): Promise<void> {
    await this.database.exclusive(connection =>
      connection
        .prepare(
          `INSERT OR REPLACE INTO operation_records
           (id, name, status, trace_id, subject_id, result, error, created_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.name,
          record.status,
          record.traceId,
          record.subjectId ?? null,
          record.result === undefined ? null : JSON.stringify(record.result),
          record.error ? JSON.stringify(record.error) : null,
          record.createdAt.toISOString(),
          record.finishedAt?.toISOString() ?? null,
        ),
    );
  }

  async findById(id: string): Promise<OperationRecord | null> {
    return this.database.exclusive(connection => {
      const row = connection.prepare('SELECT * FROM operation_records WHERE id = ?').get(id) as
        StoredRecord | undefined;
      return row ? toRecord(row) : null;
    });
  }

  async findAll(): Promise<OperationRecord[]> {
    return this.database.exclusive(connection =>
      (
        connection.prepare('SELECT * FROM operation_records ORDER BY created_at').all() as unknown as StoredRecord[]
      ).map(toRecord),
    );
  }

  async findByTraceId(traceId: string): Promise<OperationRecord[]> {
    return this.database.exclusive(connection =>
      (
        connection
          .prepare('SELECT * FROM operation_records WHERE trace_id = ? ORDER BY created_at')
          .all(traceId) as unknown as StoredRecord[]
      ).map(toRecord),
    );
  }
}

interface StoredRecord {
  id: string;
  name: string;
  status: string;
  trace_id: string;
  subject_id: string | null;
  result: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

function toRecord(row: StoredRecord): OperationRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status as OperationStatus,
    traceId: row.trace_id,
    subjectId: row.subject_id ?? undefined,
    result: row.result === null ? undefined : JSON.parse(row.result),
    error: row.error === null ? undefined : JSON.parse(row.error),
    createdAt: new Date(row.created_at),
    finishedAt: row.finished_at === null ? undefined : new Date(row.finished_at),
  };
}
