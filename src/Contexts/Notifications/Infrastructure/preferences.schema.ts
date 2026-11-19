/**
 * The notice preferences in the PostgreSQL database (ADR 27): one row per person who ever changed one, with each kind of
 * notice on or off. A person with no row has every kind on. `version` is the optimistic version the change checks.
 */
export const NOTICE_PREFERENCE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS notifications_notice_preferences (
     id TEXT PRIMARY KEY,
     member_id TEXT NOT NULL UNIQUE,
     expense_on BOOLEAN NOT NULL,
     reminder_on BOOLEAN NOT NULL,
     budget_on BOOLEAN NOT NULL,
     version BIGINT NOT NULL
   )`,
];
