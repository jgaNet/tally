import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

/**
 * The settlements' books and settlements, in the application's file, made by whoever opens it first. A group's book has one
 * row, at its version (CONC-OPTIMISTIC): 1 once its first settlement is stored, one more at each settlement after it. A
 * settlement is kept once it is recorded and never changed; its method and status are kept as they are, so that a payment the
 * provider settles can keep its own (request 20).
 */
export function createSettlementsTables(database: SqliteDatabase): void {
  database.exec(`CREATE TABLE IF NOT EXISTS settlement_books (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS settlements (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    payer TEXT NOT NULL,
    payee TEXT NOT NULL,
    amount INTEGER NOT NULL,
    method TEXT NOT NULL,
    status TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  )`);
  database.exec('CREATE INDEX IF NOT EXISTS settlements_by_group ON settlements (group_id)');
}
