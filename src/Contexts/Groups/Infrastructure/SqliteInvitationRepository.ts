import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IInvitationRepository } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationRepository';
import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';
import { InvitationSnapshot } from '@Contexts/Groups/Domain/Invitation/DTOs';

/** The invitations' table: an invitation's id is the link, so it is the primary key. */
export const INVITATIONS_SCHEMA =
  'CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups (id), invited_by TEXT NOT NULL, created_at TEXT NOT NULL, version INTEGER NOT NULL)';

type InvitationRow = { id: string; group_id: string; invited_by: string; created_at: string; version: number };

/** The invitations' store over SQLite (docs/adr/0001). Its methods run inside a transaction: the use case's. */
export class SqliteInvitationRepository implements IInvitationRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(connection => connection.exec(INVITATIONS_SCHEMA));
  }

  async findById(id: string): Promise<Invitation | undefined> {
    const row = this.database.connection
      .prepare('SELECT id, group_id, invited_by, created_at, version FROM invitations WHERE id = ?')
      .get(id) as InvitationRow | undefined;
    if (!row) return undefined;
    const snapshot: InvitationSnapshot = {
      id: String(row.id),
      groupId: String(row.group_id),
      invitedBy: String(row.invited_by),
      createdAt: String(row.created_at),
      version: Number(row.version),
    };
    return Invitation.fromSnapshot(snapshot);
  }

  async save(invitation: Invitation): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const snapshot = invitation.toSnapshot();
    const connection = this.database.connection;
    if (snapshot.version === 0) {
      connection
        .prepare('INSERT INTO invitations (id, group_id, invited_by, created_at, version) VALUES (?, ?, ?, ?, ?)')
        .run(snapshot.id, snapshot.groupId, snapshot.invitedBy, snapshot.createdAt, snapshot.version + 1);
    } else {
      const { changes } = connection
        .prepare('UPDATE invitations SET version = ? WHERE id = ? AND version = ?')
        .run(snapshot.version + 1, snapshot.id, snapshot.version);
      if (changes === 0) {
        return Result.fail(new ConcurrencyConflictException('Groups', 'The invitation changed since it was read'));
      }
    }
    return Result.ok(undefined);
  }
}
