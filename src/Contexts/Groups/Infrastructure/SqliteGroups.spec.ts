import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

import { ConcurrencyConflictException } from '@Architecture/Domain';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';

import { GroupsDatabase } from './GroupsDatabase';
import { SqliteGroups } from './SqliteGroups';
import { freshDatabaseUrl } from '@Architecture/Infrastructure/DataSources/FreshDatabase';
import { moveFromFile } from '@Architecture/Infrastructure/DataSources/MoveFromFile';

const at = new Date('2026-04-01T09:00:00.000Z');
const ownerId = '3c9d2f1e-0000-4000-8000-000000000001';
const firstId = '3c9d2f1e-0000-4000-8000-000000000002';
const secondId = '3c9d2f1e-0000-4000-8000-000000000003';

let url = '';
beforeEach(async () => {
  url = await freshDatabaseUrl();
});
/** A database of its own for the test: its URL is what the store opens. */
const newDatabasePath = () => url;

describe('saving a group over a newer version of it (CONC-OPTIMISTIC)', () => {
  it('refuses a save over a version another writer has already stored, and keeps what the other writer stored', async () => {
    const groups = new SqliteGroups(new GroupsDatabase(newDatabasePath));
    const group = Group.register({
      name: GroupName.create('Shared').data!,
      currency: Currency.create('EUR').data!,
      ownerId,
      at,
    });
    await groups.insert(group);
    const id = group._id.value;

    const firstWriter = (await groups.get(id))!;
    const secondWriter = (await groups.get(id))!;
    expect(firstWriter.version).toBe(1);
    expect(secondWriter.version).toBe(1);

    firstWriter.join(firstId, at);
    await groups.save(firstWriter);
    expect((await groups.get(id))!.version).toBe(2);

    secondWriter.join(secondId, at);
    await expect(groups.save(secondWriter)).rejects.toBeInstanceOf(ConcurrencyConflictException);

    const stored = (await groups.get(id))!;
    expect(stored.members.map(member => member.accountId)).toEqual([ownerId, firstId]);
    expect(stored.version).toBe(2);
  });
});

describe('a database written by feature 2', () => {
  it('is moved into the database with the owner joined when the group was created', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tally-feature-2-')), 'tally.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE expense_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, owner_id TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE expense_group_members (group_id TEXT NOT NULL REFERENCES expense_groups (id), account_id TEXT NOT NULL, PRIMARY KEY (group_id, account_id));
      INSERT INTO expense_groups VALUES ('6f1d2c3b-0000-4000-8000-0000000000aa', 'Old', 'EUR', '${ownerId}', '2026-04-01T09:00:00.000Z');
      INSERT INTO expense_group_members VALUES ('6f1d2c3b-0000-4000-8000-0000000000aa', '${ownerId}');
    `);
    old.close();

    // The file is moved into the database of the test, which holds nothing of Tally's yet, and the group is read from there.
    const tables = new GroupsDatabase(newDatabasePath);
    await tables.ready();
    expect(await moveFromFile(tables.database, path, [tables])).toBe(true);
    const groups = new SqliteGroups(tables);
    const group = (await groups.get('6f1d2c3b-0000-4000-8000-0000000000aa'))!;

    expect(group.version).toBe(1);
    expect(group.members).toEqual([{ accountId: ownerId, joinedAt: at }]);
  });
});

describe('a membership an older build wrote without a time', () => {
  it('reads as joined when its group was created, as a membership an older layout wrote does', async () => {
    const database = new GroupsDatabase(newDatabasePath);
    const groups = new SqliteGroups(database);
    const group = Group.register({
      name: GroupName.create('Mixed').data!,
      currency: Currency.create('EUR').data!,
      ownerId,
      at,
    });
    await database.execute(
      "INSERT INTO accounts (id, email, name, password_hash) VALUES ($1, 'owner@example.org', 'Owner', 'x')",
      [ownerId],
    );
    await groups.insert(group);
    await database.execute("UPDATE expense_group_members SET joined_at = '' WHERE group_id = $1", [group._id.value]);

    const loaded = (await groups.get(group._id.value))!;
    expect(loaded.members).toEqual([{ accountId: ownerId, joinedAt: at }]);
    expect(await groups.membersOf(group._id.value, ownerId)).toEqual([
      { memberId: ownerId, name: 'Owner', role: 'owner', joinedAt: at.toISOString() },
    ]);
  });
});
