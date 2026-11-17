import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

let database: SqliteDatabase | undefined;

/**
 * The file the application keeps its state in: the one DATABASE_PATH names, `tally.db` when it names none.
 * Opened once per process, on first use, and shared by every context's wiring (as the in-memory stores
 * are shared by the process), so that one transaction can write them all.
 */
export function applicationDatabase(): SqliteDatabase {
  return (database ??= new SqliteDatabase(process.env.DATABASE_PATH || 'tally.db'));
}
