/** The accounts' table in the PostgreSQL database (ADR 22); the email is kept in lower case and is unique (ADR 2). */
export const ACCOUNT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS accounts (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     version BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // When an administrator suspended the account (request 34, ADR 25): null while it is not suspended, cleared when reinstated.
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS suspended_at TEXT`,
  // The administrators' log of what Groups decides about accounts (request 34, ADR 25): every suspension and reinstatement, in
  // the transaction of the change; `seq` is the order they were written in, and breaks a tie of `at`.
  `CREATE TABLE IF NOT EXISTS account_administration_log (
     id TEXT PRIMARY KEY,
     at TEXT NOT NULL,
     by_id TEXT NOT NULL,
     action TEXT NOT NULL CHECK (action IN ('suspended', 'reinstated')),
     subject_id TEXT NOT NULL,
     seq BIGSERIAL
   )`,
];
