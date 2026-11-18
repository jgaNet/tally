import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

import { PostgresDatabase } from '@Architecture/Infrastructure/DataSources/PostgresDatabase';
import { moveFromFile } from '@Architecture/Infrastructure/DataSources/MoveFromFile';
import { freshDatabaseUrl } from '@Architecture/Infrastructure/DataSources/FreshDatabase';
import { GroupsDatabase } from '@Contexts/Groups/Infrastructure/GroupsDatabase';
import { SqliteGroups } from '@Contexts/Groups/Infrastructure/SqliteGroups';

const groupId = '6f1d2c3b-0000-4000-8000-0000000000bb';
const ownerId = '6f1d2c3b-0000-4000-8000-0000000000cc';

/** A file a version of Tally wrote before the members had a time: the layout of feature 2. */
function fileOfFeatureTwo(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'tally-move-')), 'tally.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE expense_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, owner_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE expense_group_members (group_id TEXT NOT NULL REFERENCES expense_groups (id), account_id TEXT NOT NULL, PRIMARY KEY (group_id, account_id));
    INSERT INTO accounts VALUES ('${ownerId}', 'owner@example.org', 'Owner', 'x');
    INSERT INTO expense_groups VALUES ('${groupId}', 'Moved', 'EUR', '${ownerId}', '2026-04-01T09:00:00.000Z');
    INSERT INTO expense_group_members VALUES ('${groupId}', '${ownerId}');
  `);
  old.close();
  return path;
}

describe('moving a file into the database', () => {
  it("moves what the file holds once, into a database that holds nothing of Tally's, and does not read the file again", async () => {
    const url = await freshDatabaseUrl();
    const tables = new GroupsDatabase(() => url);
    await tables.ready();
    const file = fileOfFeatureTwo();

    expect(await moveFromFile(PostgresDatabase.of(url), file, [tables])).toBe(true);
    const groups = new SqliteGroups(tables);
    expect((await groups.get(groupId))!.members.map(member => member.accountId)).toEqual([ownerId]);
    expect(await groups.membersOf(groupId, ownerId)).toEqual([
      expect.objectContaining({ memberId: ownerId, name: 'Owner', role: 'owner' }),
    ]);

    // The file is not read again: the marker says it was moved, so a second server's start leaves the database as it is.
    expect(await moveFromFile(PostgresDatabase.of(url), file, [tables])).toBe(false);
  });

  it("leaves a database that holds rows of Tally's as it is", async () => {
    const url = await freshDatabaseUrl();
    const tables = new GroupsDatabase(() => url);
    await tables.ready();
    await tables.execute(
      "INSERT INTO accounts (id, email, name, password_hash) VALUES ('a1', 'ada@example.org', 'Ada', 'x')",
    );

    expect(await moveFromFile(PostgresDatabase.of(url), fileOfFeatureTwo(), [tables])).toBe(false);
    expect(await tables.rows('SELECT id FROM expense_groups')).toEqual([]);
  });
});
