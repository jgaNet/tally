import { WRITE_LOCK, type Database, type Querier } from './database';

/**
 * Runs `work` in one write transaction, on a connection of its own. The transaction takes the write lock at once, so
 * the writes of every server sharing the database run one after another: nothing else writes between its reads and its
 * writes. Its writes are committed together, or rolled back when it throws. `work` must run its queries on `tx`.
 */
export async function inTransaction<T>(db: Database, work: (tx: Querier) => Promise<T>): Promise<T> {
  return db.withConnection(async connection => {
    await connection.exec('BEGIN');
    try {
      await connection.exec(`SELECT pg_advisory_xact_lock(${WRITE_LOCK})`);
      const result = await work(connection);
      await connection.exec('COMMIT');
      return result;
    } catch (error) {
      await connection.exec('ROLLBACK');
      throw error;
    }
  });
}

/**
 * Runs `work` as a read snapshot: every read it makes sees one consistent state of the database, whatever other servers
 * write meanwhile. It writes nothing.
 */
export async function inReadSnapshot<T>(db: Database, work: (snapshot: Querier) => Promise<T>): Promise<T> {
  return db.withConnection(async connection => {
    await connection.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = await work(connection);
      await connection.exec('COMMIT');
      return result;
    } catch (error) {
      await connection.exec('ROLLBACK');
      throw error;
    }
  });
}
