import { randomUUID } from 'node:crypto';
import type { Database } from '../database';

export type OperationStatus = 'PENDING' | 'SUCCESS' | 'ERROR';

export interface OperationError {
  type: string;
  message: string;
}

export interface Operation {
  id: string;
  /** The account whose token the request carried, or `null` when it carried none. */
  accountId: string | null;
  status: OperationStatus;
  result?: unknown;
  error?: OperationError;
}

interface OperationRow {
  id: string;
  account_id: string | null;
  status: OperationStatus;
  result: string | null;
  error_type: string | null;
  error_message: string | null;
}

/** Records an operation that a request answered later with `202 { operationId }`. */
export async function recordOperation(
  db: Database,
  input: { accountId: string | null; status: OperationStatus; result?: unknown; error?: OperationError },
): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO operations (id, account_id, status, result, error_type, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.accountId,
      input.status,
      input.result === undefined ? null : JSON.stringify(input.result),
      input.error?.type ?? null,
      input.error?.message ?? null,
      new Date().toISOString(),
    ],
  );
  return id;
}

export async function findOperation(db: Database, id: string): Promise<Operation | undefined> {
  const row = await db.row<OperationRow>('SELECT * FROM operations WHERE id = ?', [id]);
  if (!row) {
    return undefined;
  }
  const operation: Operation = { id: row.id, accountId: row.account_id, status: row.status };
  if (row.result !== null) {
    operation.result = JSON.parse(row.result);
  }
  if (row.error_type !== null && row.error_message !== null) {
    operation.error = { type: row.error_type, message: row.error_message };
  }
  return operation;
}
