import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { OperationStatus } from '@Architecture/Application';

import { IOperationRecords } from '@Contexts/Tracker/Application/Ports/IOperationRecords';
import { OperationRecord } from '@Contexts/Tracker/Application/ReadModel/OperationRecord';

interface Row {
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

/**
 * The operations in the application's file, so that a client answered 202 finds its operation whichever server
 * it asks and after any restart. A record is written again under its id each time its status moves; the writes
 * of one process reach the file in the order they were made.
 */
export class SqliteOperationRecords implements IOperationRecords {
  constructor(private database: SqliteDatabase) {
    database.exec(`CREATE TABLE IF NOT EXISTS operation_records (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      subject_id TEXT,
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    )`);
    database.exec('CREATE INDEX IF NOT EXISTS operation_records_trace ON operation_records (trace_id)');
  }

  async save(record: OperationRecord): Promise<void> {
    await this.database.exclusive(() =>
      this.database.run(
        `INSERT INTO operation_records
           (id, name, status, trace_id, subject_id, result, error, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = excluded.status, result = excluded.result, error = excluded.error,
           finished_at = excluded.finished_at
         WHERE operation_records.status IN ('PENDING', 'SENT') OR excluded.status IN ('SUCCESS', 'ERROR')`,
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
    const row = await this.database.exclusive(() =>
      this.database.get<Row>('SELECT * FROM operation_records WHERE id = ?', id),
    );
    return row ? toRecord(row) : null;
  }

  async findAll(): Promise<OperationRecord[]> {
    const rows = await this.database.exclusive(() =>
      this.database.all<Row>('SELECT * FROM operation_records ORDER BY created_at, rowid'),
    );
    return rows.map(toRecord);
  }

  async findByTraceId(traceId: string): Promise<OperationRecord[]> {
    const rows = await this.database.exclusive(() =>
      this.database.all<Row>('SELECT * FROM operation_records WHERE trace_id = ? ORDER BY created_at, rowid', traceId),
    );
    return rows.map(toRecord);
  }
}

function toRecord(row: Row): OperationRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status as OperationStatus,
    traceId: row.trace_id,
    ...(row.subject_id !== null && { subjectId: row.subject_id }),
    ...(row.result !== null && { result: JSON.parse(row.result) as unknown }),
    ...(row.error !== null && { error: JSON.parse(row.error) as { type: string; message: string } }),
    createdAt: new Date(row.created_at),
    ...(row.finished_at !== null && { finishedAt: new Date(row.finished_at) }),
  };
}
