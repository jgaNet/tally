import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** The state of an operation: `PENDING` until it ends, then `SUCCESS` with a result or `ERROR` with a refusal. */
export type Outcome =
  | { status: 'PENDING' }
  | { status: 'SUCCESS'; result?: unknown }
  | { status: 'ERROR'; error: { type: string; message: string } };

export interface Operation {
  readonly id: string;
  /** The account whose token the request carried, or `null` when it carried none. */
  readonly accountId: string | null;
  readonly outcome: Outcome;
}

interface OperationRow {
  id: string;
  status: Outcome['status'];
  result: string | null;
  error_type: string | null;
  error_message: string | null;
  account_id: string | null;
}

/** Records an operation a request started, and returns its id. */
export function recordOperation(db: DatabaseSync, input: { accountId: string | null; outcome: Outcome }): string {
  const { accountId, outcome } = input;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO operations (id, status, result, error_type, error_message, account_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    outcome.status,
    outcome.status === 'SUCCESS' && outcome.result !== undefined ? JSON.stringify(outcome.result) : null,
    outcome.status === 'ERROR' ? outcome.error.type : null,
    outcome.status === 'ERROR' ? outcome.error.message : null,
    accountId,
    new Date().toISOString(),
  );
  return id;
}

/** The operation with this id, or `undefined`. Reading never changes it. */
export function findOperation(db: DatabaseSync, id: string): Operation | undefined {
  const row = db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as OperationRow | undefined;
  if (!row) return undefined;
  return { id: row.id, accountId: row.account_id, outcome: outcomeOf(row) };
}

function outcomeOf(row: OperationRow): Outcome {
  switch (row.status) {
    case 'PENDING':
      return { status: 'PENDING' };
    case 'SUCCESS':
      return row.result === null ? { status: 'SUCCESS' } : { status: 'SUCCESS', result: JSON.parse(row.result) };
    case 'ERROR':
      return { status: 'ERROR', error: { type: row.error_type ?? '', message: row.error_message ?? '' } };
  }
}
