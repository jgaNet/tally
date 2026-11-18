import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

let database: PostgresDatabase | undefined;

/**
 * The database the application keeps its state in: the one DATABASE_URL names (ADR 20). Created once per process, on first
 * use, and shared by every context's wiring (as the in-memory stores are shared by the process), so that one transaction
 * can write them all. It is opened by the composition root before it serves (createApplication).
 */
export function applicationDatabase(): PostgresDatabase {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL names no PostgreSQL database: the application keeps its state there');
  }
  return (database ??= new PostgresDatabase(process.env.DATABASE_URL));
}
