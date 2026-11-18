import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PoolClient } from 'pg';
import { migrateLegacy } from './sqlite-schema';

/**
 * A table of Tally's, and what is moved of it: its columns, which are the same in the file and in PostgreSQL, and the
 * identity column its rows are ordered by, when it has one. For `seq`, the file's own row order (its rowid) is kept, so
 * that the rows keep the order they were made in; for `id`, the file's id is kept as it is.
 */
interface ImportedTable {
  readonly name: string;
  readonly columns: readonly string[];
  readonly identity?: 'seq' | 'id';
}

/** The tables, in the order a row's parent is written before it. */
export const IMPORTED_TABLES: readonly ImportedTable[] = [
  { name: 'accounts', columns: ['id', 'email', 'email_key', 'name', 'password_salt', 'password_hash', 'created_at'] },
  { name: 'sessions', columns: ['token_hash', 'account_id', 'created_at'] },
  {
    name: 'operations',
    columns: ['id', 'account_id', 'status', 'result', 'error_type', 'error_message', 'created_at'],
  },
  { name: 'groups', columns: ['id', 'name', 'currency', 'owner_id', 'created_at', 'archived_at'], identity: 'seq' },
  { name: 'memberships', columns: ['group_id', 'account_id', 'joined_at'], identity: 'seq' },
  { name: 'invitations', columns: ['id_hash', 'group_id', 'invited_by', 'created_at'] },
  {
    name: 'expenses',
    columns: [
      'id',
      'group_id',
      'description',
      'amount',
      'date',
      'paid_by',
      'created_at',
      'version',
      'split_kind',
      'original_currency',
      'original_amount',
      'original_rate',
      'category',
    ],
    identity: 'seq',
  },
  { name: 'expense_shares', columns: ['expense_id', 'position', 'member_id', 'amount'] },
  { name: 'former_members', columns: ['group_id', 'account_id', 'left_at'] },
  {
    name: 'settlements',
    columns: [
      'id',
      'group_id',
      'payer_id',
      'payee_id',
      'amount',
      'method',
      'status',
      'pay_url',
      'provider_payment_id',
      'created_at',
    ],
    identity: 'seq',
  },
  { name: 'payout_accounts', columns: ['account_id', 'provider_account_id', 'set_at'] },
  {
    name: 'notices',
    columns: [
      'id',
      'account_id',
      'kind',
      'group_id',
      'expense_id',
      'category',
      'month',
      'budget',
      'amount',
      'created_at',
    ],
    identity: 'seq',
  },
  { name: 'noted_debts', columns: ['group_id', 'account_id', 'noted_at'] },
  { name: 'settlement_statuses', columns: ['id', 'settlement_id', 'status', 'at'], identity: 'id' },
  { name: 'balance_transfers', columns: ['id', 'group_id', 'from_id', 'to_id', 'amount', 'at'], identity: 'id' },
  {
    name: 'recurring',
    columns: [
      'id',
      'group_id',
      'paid_by',
      'description',
      'amount',
      'split',
      'starts_on',
      'next_on',
      'created_at',
      'category',
    ],
    identity: 'seq',
  },
  { name: 'budgets', columns: ['group_id', 'category', 'amount', 'set_at'] },
  { name: 'budget_passings', columns: ['group_id', 'category', 'month', 'at'] },
  {
    name: 'split_templates',
    columns: ['id', 'group_id', 'created_by', 'name', 'name_key', 'split', 'created_at'],
    identity: 'seq',
  },
  { name: 'receipts', columns: ['expense_id', 'type', 'size', 'url', 'store_id', 'attached_at'] },
  {
    name: 'audit_entries',
    columns: ['id', 'group_id', 'at', 'by_id', 'action', 'subject_id', 'amount'],
    identity: 'seq',
  },
];

/**
 * Moves everything a file of Tally's holds into the PostgreSQL transaction `client` is in, and records that the database
 * was imported. The file itself is never written: it is copied, the copy is brought up to the latest schema as an
 * earlier version brought the file up on opening, and the copy is what is read.
 */
export async function importLegacyFile(client: PoolClient, file: string): Promise<number> {
  const directory = mkdtempSync(join(tmpdir(), 'tally-import-'));
  let moved = 0;
  try {
    const copy = join(directory, 'tally.db');
    const source = new DatabaseSync(file);
    try {
      source.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    } finally {
      source.close();
    }
    const legacy = new DatabaseSync(copy);
    try {
      migrateLegacy(legacy);
      for (const table of IMPORTED_TABLES) {
        const columns = table.identity === 'seq' ? ['seq', ...table.columns] : [...table.columns];
        const selected = table.identity === 'seq' ? ['rowid AS seq', ...table.columns] : [...table.columns];
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
        const insert = `INSERT INTO ${table.name} (${columns.join(', ')}) VALUES (${placeholders})`;
        const rows = legacy.prepare(`SELECT ${selected.join(', ')} FROM ${table.name} ORDER BY rowid`).all() as Record<
          string,
          unknown
        >[];
        for (const row of rows) {
          await client.query(
            insert,
            columns.map(column => row[column] ?? null),
          );
          moved += 1;
        }
        if (table.identity !== undefined) {
          await client.query(
            `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${table.identity}) FROM ${table.name}), 0) + 1, false)`,
            [table.name, table.identity],
          );
        }
      }
    } finally {
      legacy.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  await client.query('INSERT INTO legacy_import (id, imported_at) VALUES (1, $1)', [new Date().toISOString()]);
  return moved;
}
