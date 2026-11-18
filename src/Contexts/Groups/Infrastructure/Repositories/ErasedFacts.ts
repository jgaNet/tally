import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

/** What a name or an email erased is replaced by, wherever a fact kept about the account holds it (request 35). */
export const ERASED = '[erased]';

/**
 * Erases the name and the email of a deleted account from the facts kept about it, in the transaction of its deletion (request
 * 35): the outbox's entries and the operation records that name the account by its id, its id being the one thing that stays.
 * Only a value that is exactly the name or the email is replaced, wherever it sits in the fact; a text that merely contains it
 * is kept as it is, so nothing else a fact says changes. A table that is not there yet holds no such fact and is skipped.
 */
export async function eraseFactsOf(database: PostgresDatabase, accountId: string, values: string[]): Promise<void> {
  const pattern = `%${accountId}%`;

  if (await tableExists(database, 'outbox')) {
    const entries = await database.all<{ id: string; payload: string }>(
      'SELECT id, payload FROM outbox WHERE payload LIKE ?',
      [pattern],
    );
    for (const entry of entries) {
      const payload = eraseIn(entry.payload, values);
      if (payload !== entry.payload)
        await database.run('UPDATE outbox SET payload = ? WHERE id = ?', [payload, entry.id]);
    }
  }

  if (await tableExists(database, 'operation_records')) {
    const records = await database.all<{ id: string; result: string | null; error: string | null }>(
      'SELECT id, result, error FROM operation_records WHERE result LIKE ? OR error LIKE ?',
      [pattern, pattern],
    );
    for (const record of records) {
      const result = record.result === null ? null : eraseIn(record.result, values);
      const error = record.error === null ? null : eraseIn(record.error, values);
      if (result !== record.result || error !== record.error) {
        await database.run('UPDATE operation_records SET result = ?, error = ? WHERE id = ?', [
          result,
          error,
          record.id,
        ]);
      }
    }
  }
}

async function tableExists(database: PostgresDatabase, table: string): Promise<boolean> {
  const row = await database.get<{ found: string | null }>('SELECT to_regclass(?) AS found', [table]);
  return row?.found != null;
}

/** The text of a stored JSON fact, with each string value that is exactly one of `values` erased; the same text when none is. */
function eraseIn(text: string, values: string[]): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const erased = replaceWhole(parsed, values);
  return erased.changed ? JSON.stringify(erased.value) : text;
}

function replaceWhole(value: unknown, values: string[]): { value: unknown; changed: boolean } {
  if (typeof value === 'string')
    return values.includes(value) ? { value: ERASED, changed: true } : { value, changed: false };
  if (Array.isArray(value)) {
    const items = value.map(item => replaceWhole(item, values));
    return { value: items.map(item => item.value), changed: items.some(item => item.changed) };
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => [key, replaceWhole(item, values)] as const);
    return {
      value: Object.fromEntries(entries.map(([key, item]) => [key, item.value])),
      changed: entries.some(([, item]) => item.changed),
    };
  }
  return { value, changed: false };
}
