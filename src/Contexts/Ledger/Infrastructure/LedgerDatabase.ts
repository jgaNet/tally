import { DatabaseSync } from 'node:sqlite';

import { SqliteFile } from '@Architecture/Infrastructure/DataSources/SqliteFile';

/**
 * The SQLite file the Ledger context keeps its expenses in, opened on first use at the path `pathOf` gives then. It is
 * the application's database file, under tables of its own (ADR 5), and several servers may open it: WAL lets them read
 * while one writes, and a busy timeout lets a write wait its turn.
 */
export class LedgerDatabase {
  #ready = false;
  #file?: SqliteFile;

  constructor(private readonly pathOf: () => string) {}

  /** The file the context's rows are in: the one file of the process at that path (ADR 17), whose writes are transactions. */
  get file(): SqliteFile {
    this.#file ??= SqliteFile.of(this.pathOf());
    return this.#file;
  }

  get connection(): DatabaseSync {
    const connection = this.file.connection;
    if (!this.#ready) {
      this.#ready = this.file.schema(connection => {
        connection.exec(`
        CREATE TABLE IF NOT EXISTS ledger_expenses (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL,
          description TEXT NOT NULL,
          amount INTEGER NOT NULL,
          date TEXT NOT NULL,
          paid_by TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          split_kind TEXT NOT NULL DEFAULT 'equal'
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
        this.#migrate(connection);
      });
    }
    return connection;
  }

  /**
   * What a file written before this layout needs, made once, in one transaction so that two servers opening the file at
   * once cannot do it twice (feature 6, feature 5):
   * - the version of each expense, which a file of feature 4 did not keep: every expense it holds is at version 1, as it
   *   was recorded and never edited;
   * - the way each expense was split (request 7): every expense a file holds before it was split equally, as feature 4
   *   recorded them;
   * - the order each expense was first recorded in (request 8): `recorded_seq`, a number an insert takes one more than
   *   the last, which an edit never changes; the expenses a file holds take their rows' order;
   * - the table of balances, the read model `GetGroupBalances` reads: one row per member per group, kept in the same
   *   transaction as the expenses that move it. When a file had expenses before it existed, it is filled from them;
   * - what an expense paid in another currency was paid as (request 21): three columns, empty for every expense in the
   *   group's currency, which a file of an earlier layout holds all of.
   */
  #migrate(connection: DatabaseSync): void {
    const hasVersion = connection
      .prepare("SELECT 1 FROM pragma_table_info('ledger_expenses') WHERE name = 'version'")
      .get();
    if (!hasVersion) {
      connection.exec('ALTER TABLE ledger_expenses ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
    }
    const hasSplitKind = connection
      .prepare("SELECT 1 FROM pragma_table_info('ledger_expenses') WHERE name = 'split_kind'")
      .get();
    if (!hasSplitKind) {
      connection.exec("ALTER TABLE ledger_expenses ADD COLUMN split_kind TEXT NOT NULL DEFAULT 'equal'");
    }
    const hasRecordedSeq = connection
      .prepare("SELECT 1 FROM pragma_table_info('ledger_expenses') WHERE name = 'recorded_seq'")
      .get();
    if (!hasRecordedSeq) {
      connection.exec('ALTER TABLE ledger_expenses ADD COLUMN recorded_seq INTEGER NOT NULL DEFAULT 0');
      // Every expense a file holds was recorded before this column existed, in the order its rows were written.
      connection.exec('UPDATE ledger_expenses SET recorded_seq = rowid');
    }
    const hasOriginal = connection
      .prepare("SELECT 1 FROM pragma_table_info('ledger_expenses') WHERE name = 'original_currency'")
      .get();
    if (!hasOriginal) {
      connection.exec(`
          ALTER TABLE ledger_expenses ADD COLUMN original_currency TEXT;
          ALTER TABLE ledger_expenses ADD COLUMN original_amount INTEGER;
          ALTER TABLE ledger_expenses ADD COLUMN original_rate TEXT;
        `);
    }
    const hasBalances = connection
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_balances'")
      .get();
    if (!hasBalances) {
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
  }
}
