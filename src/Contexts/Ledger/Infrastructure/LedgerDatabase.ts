import { DatabaseSync } from 'node:sqlite';

/**
 * The SQLite file the Ledger context keeps its expenses in, opened on first use at the path `pathOf` gives then. It is
 * the application's database file, under tables of its own (ADR 5), and several servers may open it: WAL lets them read
 * while one writes, and a busy timeout lets a write wait its turn.
 */
export class LedgerDatabase {
  #connection?: DatabaseSync;

  constructor(private readonly pathOf: () => string) {}

  get connection(): DatabaseSync {
    if (!this.#connection) {
      const connection = new DatabaseSync(this.pathOf());
      connection.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS ledger_expenses (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL,
          description TEXT NOT NULL,
          amount INTEGER NOT NULL,
          date TEXT NOT NULL,
          paid_by TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ledger_expenses_by_group ON ledger_expenses (group_id);
        CREATE TABLE IF NOT EXISTS ledger_expense_shares (
          expense_id TEXT NOT NULL REFERENCES ledger_expenses (id),
          position INTEGER NOT NULL,
          member_id TEXT NOT NULL,
          amount INTEGER NOT NULL,
          PRIMARY KEY (expense_id, position)
        );
      `);
      this.#createBalances(connection);
      this.#connection = connection;
    }
    return this.#connection;
  }

  /**
   * The table of balances, the read model `GetGroupBalances` reads: one row per member per group, kept in the same
   * transaction as the expenses that move it. Made once: when a file had expenses before it existed, it is filled from them
   * in the same transaction, so two servers opening the file at once cannot count an expense twice.
   */
  #createBalances(connection: DatabaseSync): void {
    connection.exec('BEGIN IMMEDIATE');
    try {
      const present = connection
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_balances'")
        .get();
      if (!present) {
        connection.exec(`
          CREATE TABLE ledger_balances (
            group_id TEXT NOT NULL,
            member_id TEXT NOT NULL,
            balance INTEGER NOT NULL,
            PRIMARY KEY (group_id, member_id)
          );
          INSERT INTO ledger_balances (group_id, member_id, balance)
            SELECT group_id, member_id, SUM(balance) FROM (
              SELECT group_id, paid_by AS member_id, amount AS balance FROM ledger_expenses
              UNION ALL
              SELECT e.group_id, s.member_id, -s.amount
                FROM ledger_expense_shares s JOIN ledger_expenses e ON e.id = s.expense_id
            ) GROUP BY group_id, member_id;
        `);
      }
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }
}
