import { OperationStatus } from '@Architecture/Application';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IOperationRecords } from '@Contexts/Tracker/Application/Ports/IOperationRecords';
import { OperationRecord } from '@Contexts/Tracker/Application/ReadModel/OperationRecord';

/**
 * The operation records over the application's PostgreSQL database, so that an operation a client was answered with
 * (`202 { operationId }`) is still there to be followed after the server restarts. A record is written by the bus, outside
 * any transaction of a command, and each write is its own statement.
 */
export class PostgresOperationRecords implements IOperationRecords {
  constructor(private database: PostgresDatabase) {
    database.define(`
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
    await this.database.run(
      `INSERT INTO operation_records
       (id, name, status, trace_id, subject_id, result, error, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         trace_id = EXCLUDED.trace_id,
         subject_id = EXCLUDED.subject_id,
         result = EXCLUDED.result,
         error = EXCLUDED.error,
         created_at = EXCLUDED.created_at,
         finished_at = EXCLUDED.finished_at`,
      [
        record.id,
        record.name,
        record.status,
        record.traceId,
        record.subjectId ?? null,
        record.result === undefined ? null : JSON.stringify(record.result),
        record.error ? JSON.stringify(record.error) : null,
        record.createdAt.toISOString(),
        record.finishedAt?.toISOString() ?? null,
      ],
    );
  }

  async findById(id: string): Promise<OperationRecord | null> {
    const row = await this.database.get<StoredRecord>('SELECT * FROM operation_records WHERE id = ?', [id]);
    return row ? toRecord(row) : null;
  }

  async findAll(): Promise<OperationRecord[]> {
    const rows = await this.database.all<StoredRecord>('SELECT * FROM operation_records ORDER BY created_at');
    return rows.map(toRecord);
  }

  async findByTraceId(traceId: string): Promise<OperationRecord[]> {
    const rows = await this.database.all<StoredRecord>(
      'SELECT * FROM operation_records WHERE trace_id = ? ORDER BY created_at',
      [traceId],
    );
    return rows.map(toRecord);
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
