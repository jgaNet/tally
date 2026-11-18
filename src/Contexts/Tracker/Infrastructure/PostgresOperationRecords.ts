import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { IOperationRecords } from '@Contexts/Tracker/Application/Ports/IOperationRecords';
import { OperationRecord } from '@Contexts/Tracker/Application/ReadModel/OperationRecord';

/**
 * The operations in the PostgreSQL database (ADR 22), so that a restarted server, or another one on the same
 * database, answers an operation a client was given. A record is written on its own, outside the
 * transaction of the command it reports (an operation refused by a rollback is still recorded).
 */
export class PostgresOperationRecords implements IOperationRecords {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate([
      `CREATE TABLE IF NOT EXISTS operation_records (
         seq BIGSERIAL PRIMARY KEY,
         id TEXT NOT NULL UNIQUE,
         trace_id TEXT NOT NULL,
         record TEXT NOT NULL
       )`,
      'CREATE INDEX IF NOT EXISTS operation_records_trace ON operation_records (trace_id)',
      // Records moved from the SQLite file keep their `seq`: the sequence is taken past them, so that a record written after
      // the move does not take one of theirs. It only ever moves forward.
      `SELECT setval(pg_get_serial_sequence('operation_records', 'seq'), MAX(seq))
         FROM operation_records
       HAVING MAX(seq) >= (SELECT last_value FROM operation_records_seq_seq)`,
    ]);
  }

  async save(record: OperationRecord): Promise<void> {
    await this.database.exclusive(connection =>
      connection.run(
        `INSERT INTO operation_records (id, trace_id, record) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET record = excluded.record`,
        record.id,
        record.traceId,
        JSON.stringify(record),
      ),
    );
  }

  async findById(id: string): Promise<OperationRecord | null> {
    const row = await this.database.exclusive(connection =>
      connection.row<{ record: string }>('SELECT record FROM operation_records WHERE id = ?', id),
    );
    return row ? revive(row.record) : null;
  }

  async findAll(): Promise<OperationRecord[]> {
    const rows = await this.database.exclusive(connection =>
      connection.rows<{ record: string }>('SELECT record FROM operation_records ORDER BY seq'),
    );
    return rows.map(row => revive(row.record));
  }

  async findByTraceId(traceId: string): Promise<OperationRecord[]> {
    const rows = await this.database.exclusive(connection =>
      connection.rows<{ record: string }>(
        'SELECT record FROM operation_records WHERE trace_id = ? ORDER BY seq',
        traceId,
      ),
    );
    return rows.map(row => revive(row.record));
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
