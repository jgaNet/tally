import type { DatabaseSync } from 'node:sqlite';

/**
 * The Settlements context's schema steps as the SQLite file kept them, in the order the version that wrote the file ran them on opening
 * it (docs/adr/0029). Used only to bring such a file to the shape the current version reads before it is moved into the database; it
 * runs nothing else. Self-contained: it does not import the stores.
 */
export function upgradeSettlementsFile(connection: DatabaseSync): void {
  // The settlements' books and settlements (docs/adr/0013, request 13).
  connection.exec(
    [
      'CREATE TABLE IF NOT EXISTS settlement_books (group_id TEXT PRIMARY KEY, version INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS settlements (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, payer_id TEXT NOT NULL, payee_id TEXT NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL, recorded_at TEXT NOT NULL, pay_url TEXT, provider_payment_id TEXT)',
    ].join(';\n'),
  );
  // A file made before request 13 has the table without the provider's columns: they are added, once.
  const columns = (connection.prepare('PRAGMA table_info(settlements)').all() as Array<{ name: string }>).map(
    column => column.name,
  );
  if (!columns.includes('pay_url')) connection.exec('ALTER TABLE settlements ADD COLUMN pay_url TEXT');
  if (!columns.includes('provider_payment_id')) {
    connection.exec('ALTER TABLE settlements ADD COLUMN provider_payment_id TEXT');
  }
  connection.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS settlements_by_provider_payment ON settlements (provider_payment_id)',
  );
  // Each status a settlement has had, and when Tally learned it (request 19). A file made before request 19 gets each settlement's
  // first line from the method that recorded it, at the time it was recorded.
  connection.exec(
    [
      'CREATE TABLE IF NOT EXISTS settlement_statuses (settlement_id TEXT NOT NULL, status TEXT NOT NULL, learned_at TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS settlement_statuses_by_settlement ON settlement_statuses (settlement_id)',
    ].join(';\n'),
  );
  // The group's audit of the changes of money the book makes (request 28, docs/adr/0027).
  connection.exec(
    'CREATE TABLE IF NOT EXISTS settlement_audit (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, at TEXT NOT NULL, by_id TEXT NOT NULL, action TEXT NOT NULL, subject_id TEXT NOT NULL, amount INTEGER NOT NULL)',
  );
  // Read first: a file with every settlement's line is only read, never written (a write here would lock the file for the others).
  const unlined = connection
    .prepare(
      'SELECT 1 FROM settlements s WHERE NOT EXISTS (SELECT 1 FROM settlement_statuses l WHERE l.settlement_id = s.id) LIMIT 1',
    )
    .get();
  if (unlined) {
    connection.exec(
      "INSERT INTO settlement_statuses (settlement_id, status, learned_at) SELECT id, CASE method WHEN 'cash' THEN 'paid' ELSE 'pending' END, recorded_at FROM settlements s WHERE NOT EXISTS (SELECT 1 FROM settlement_statuses l WHERE l.settlement_id = s.id)",
    );
  }

  // The payout accounts: one row per person (request 16).
  connection.exec(
    'CREATE TABLE IF NOT EXISTS payout_accounts (account_id TEXT PRIMARY KEY, provider_account_id TEXT NOT NULL, version INTEGER NOT NULL)',
  );
}
