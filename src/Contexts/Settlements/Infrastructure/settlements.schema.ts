/**
 * Takes the sequence of `table.column` past the largest value the table holds, when rows were written with their own value
 * (the move from the SQLite file); a sequence already past them is left as it is.
 */
function advancePast(table: string, column: string): string {
  return `SELECT setval(pg_get_serial_sequence('${table}', '${column}'), MAX(${column}))
            FROM ${table}
          HAVING MAX(${column}) >= (SELECT last_value FROM ${table}_${column}_seq)`;
}

/**
 * Settlements' tables in the PostgreSQL database (ADR 22, ADR 7, ADR 8). `settlement_books` holds each group's book at its version,
 * which the optimistic check reads; `settlements` holds each settlement, with its payer, payee, amount, method, status and
 * when it was recorded, and for a payment through the provider its id at the provider and its link. A settlement's status
 * changes from pending to paid or failed, when the provider says so; from paid to refunding when its payee asks for a refund,
 * and to refunded when the provider says so (ADR 9). `settlement_history` holds every status a settlement has had, each with
 * when Tally learned it, written in the transaction of the change (request 19). A table an earlier version made keeps its
 * CHECK: it is created again. `rowid` is the order the settlements were written in, as SQLite's own was, and breaks a tie of
 * `recorded_at`. The tables and their columns are those of the SQLite file, which the move copies as they are.
 */
export const SETTLEMENT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS settlement_books (
     group_id TEXT PRIMARY KEY,
     version BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS settlements (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL,
     payer_id TEXT NOT NULL,
     payee_id TEXT NOT NULL,
     amount BIGINT NOT NULL,
     method TEXT NOT NULL CHECK (method IN ('cash', 'provider')),
     status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded')),
     recorded_at TEXT NOT NULL,
     provider_payment_id TEXT,
     pay_url TEXT,
     rowid BIGSERIAL
   )`,
  `CREATE INDEX IF NOT EXISTS settlements_by_group ON settlements (group_id)`,
  `CREATE INDEX IF NOT EXISTS settlements_by_provider_payment ON settlements (provider_payment_id)`,
  // Every status a settlement has had, the earliest first, each with when Tally learned it (request 19). A settlement recorded
  // before this table existed has the one status it has now, learned when it was recorded: the backfill keeps that true.
  `CREATE TABLE IF NOT EXISTS settlement_history (
     id BIGSERIAL PRIMARY KEY,
     settlement_id TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded')),
     at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS settlement_history_by_settlement ON settlement_history (settlement_id)`,
  `INSERT INTO settlement_history (settlement_id, status, at)
     SELECT id, status, recorded_at FROM settlements
     WHERE NOT EXISTS (SELECT 1 FROM settlement_history WHERE settlement_history.settlement_id = settlements.id)
     ORDER BY recorded_at, rowid`,
  // A history moved from the SQLite file keeps its ids, which its sequence did not give: the sequence is taken past them, so
  // that the next status learned (a webhook after the move) is written after them. It only ever moves forward.
  advancePast('settlement_history', 'id'),
  advancePast('settlements', 'rowid'),
  // A person's payout account at the provider (request 16, ADR 10): one row per person, replaced when they set another.
  `CREATE TABLE IF NOT EXISTS payout_accounts (
     id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL UNIQUE,
     account_id TEXT NOT NULL,
     version BIGINT NOT NULL
   )`,
];
