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
 * Request 33 adds the statuses `contested` and `annulled` (ADR 24), and the administrators' log, `administrator_decisions`, one
 * row per decision an administrator made, written in the transaction of the decision.
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
     method TEXT NOT NULL CHECK (method IN ('cash', 'provider', 'net')),
     status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded', 'contested', 'annulled')),
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
     status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded', 'contested', 'annulled')),
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
  // A table an earlier version made keeps its CHECK on the status: a contested or annulled settlement (request 33) is the two
  // values it adds, so the CHECK is widened when it does not hold them yet, here and on the history.
  `DO $$
   BEGIN
     IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settlements_status_check'
                AND pg_get_constraintdef(oid) NOT LIKE '%''annulled''%') THEN
       ALTER TABLE settlements DROP CONSTRAINT settlements_status_check;
       ALTER TABLE settlements ADD CONSTRAINT settlements_status_check
         CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded', 'contested', 'annulled'));
     END IF;
     IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settlement_history_status_check'
                AND pg_get_constraintdef(oid) NOT LIKE '%''annulled''%') THEN
       ALTER TABLE settlement_history DROP CONSTRAINT settlement_history_status_check;
       ALTER TABLE settlement_history ADD CONSTRAINT settlement_history_status_check
         CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded', 'contested', 'annulled'));
     END IF;
   END
   $$`,
  // A table an earlier version made keeps its CHECK on the method: a settlement made by a netting (request 32) is the value it
  // adds, so the CHECK is widened when it does not hold it yet.
  `DO $$
   BEGIN
     IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settlements_method_check'
                AND pg_get_constraintdef(oid) NOT LIKE '%''net''%') THEN
       ALTER TABLE settlements DROP CONSTRAINT settlements_method_check;
       ALTER TABLE settlements ADD CONSTRAINT settlements_method_check CHECK (method IN ('cash', 'provider', 'net'));
     END IF;
   END
   $$`,
  // A netting (request 32, ADR 23): who asked, with whom, the currency, the amount, and the settlements it made, in the order made.
  // A settlement is netted once, so its id is unique in `netting_settlements`.
  `CREATE TABLE IF NOT EXISTS nettings (
     id TEXT PRIMARY KEY,
     by_id TEXT NOT NULL,
     with_id TEXT NOT NULL,
     currency TEXT NOT NULL,
     amount BIGINT NOT NULL,
     netted_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS netting_settlements (
     netting_id TEXT NOT NULL,
     position BIGINT NOT NULL,
     settlement_id TEXT NOT NULL UNIQUE,
     PRIMARY KEY (netting_id, position)
   )`,
  // The administrators' log (request 33, ADR 24): every decision an administrator made about a contested settlement, in the
  // transaction of the decision; `seq` is the order they were written in, and breaks a tie of `at`.
  `CREATE TABLE IF NOT EXISTS administrator_decisions (
     id TEXT PRIMARY KEY,
     at TEXT NOT NULL,
     by_id TEXT NOT NULL,
     action TEXT NOT NULL CHECK (action IN ('decided-paid', 'decided-annulled')),
     subject_id TEXT NOT NULL,
     seq BIGSERIAL
   )`,
  `CREATE INDEX IF NOT EXISTS administrator_decisions_by_subject ON administrator_decisions (subject_id)`,
  // The provider's fee (request 38): the group's policy, who bears the fee (the payee until an owner decides), and for each
  // settlement through the provider asked from then on, what it settles, its fee and who bore it. A settlement asked before has
  // none of them, and settles its amount: every read of what a settlement settles takes COALESCE(settled, amount).
  `ALTER TABLE settlement_books ADD COLUMN IF NOT EXISTS fee_borne_by TEXT CHECK (fee_borne_by IN ('payer', 'payee', 'shared'))`,
  `ALTER TABLE settlements ADD COLUMN IF NOT EXISTS settled BIGINT`,
  `ALTER TABLE settlements ADD COLUMN IF NOT EXISTS fee_amount BIGINT`,
  `ALTER TABLE settlements ADD COLUMN IF NOT EXISTS fee_borne_by TEXT CHECK (fee_borne_by IN ('payer', 'payee', 'shared'))`,
  // A person's payout account at the provider (request 16, ADR 10): one row per person, replaced when they set another.
  `CREATE TABLE IF NOT EXISTS payout_accounts (
     id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL UNIQUE,
     account_id TEXT NOT NULL,
     version BIGINT NOT NULL
   )`,
  // A settlement paid in another currency (request 39): what it was paid in, its hundredths, and the rate decided on. All three are
  // null for one in the group's currency, which reads as before; a rate is kept as the rates service wrote it.
  `ALTER TABLE settlements ADD COLUMN IF NOT EXISTS original_currency TEXT CHECK (original_currency IN ('EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'))`,
  `ALTER TABLE settlements ADD COLUMN IF NOT EXISTS original_amount BIGINT`,
  `ALTER TABLE settlements ADD COLUMN IF NOT EXISTS original_rate TEXT`,
  // A payment in a currency with no minor unit or with three decimals (request 40): the CHECK on the original's currency is widened
  // when it does not hold the four values it adds, the same as the other CHECKs an earlier version made.
  `DO $$
   BEGIN
     IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settlements_original_currency_check'
                AND pg_get_constraintdef(oid) NOT LIKE '%''BHD''%') THEN
       ALTER TABLE settlements DROP CONSTRAINT settlements_original_currency_check;
       ALTER TABLE settlements ADD CONSTRAINT settlements_original_currency_check
         CHECK (original_currency IN ('EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'KRW', 'KWD', 'BHD'));
     END IF;
   END
   $$`,
];
