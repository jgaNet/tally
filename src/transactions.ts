import type { DatabaseSync } from 'node:sqlite';

/**
 * Runs `work` in one write transaction, taken at once (`BEGIN IMMEDIATE`) so another server sharing
 * the file cannot interleave. Its writes are committed together, or rolled back when it throws.
 */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Runs `work` as a read snapshot: every read it makes sees one consistent state of the file, whatever
 * other servers write meanwhile. It writes nothing.
 */
export function inReadSnapshot<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
