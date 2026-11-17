import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';
import { IInvitationSnapshot } from '@Contexts/Groups/Domain/Invitation/DTOs';
import { IInvitationRepository } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationRepository';

/** The table of invitations: one row per invitation, its id the link. */
export function createInvitationsTable(database: SqliteDatabase): void {
  database.connection.exec(`
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      invited_by TEXT NOT NULL,
      version INTEGER NOT NULL
    );
  `);
}

interface InvitationRow {
  id: string;
  group_id: string;
  invited_by: string;
  version: number;
}

/** The invitations as aggregates, over the application's SQLite file, inside the transaction of the command. */
export class SqliteInvitationRepository implements IInvitationRepository {
  constructor(private database: SqliteDatabase) {
    createInvitationsTable(database);
  }

  async findById(id: string): Promise<Invitation | null> {
    const row = this.database.connection.prepare('SELECT * FROM invitations WHERE id = ?').get(id) as
      InvitationRow | undefined;
    if (!row) return null;

    return Invitation.fromSnapshot(toSnapshot(row));
  }

  /** An invitation is stored once, at version 1; one already stored is a conflict, since nothing changes it. */
  async save(invitation: Invitation): Promise<IResult> {
    const { _id: id, groupId, invitedBy, version } = invitation.toSnapshot();

    const stored = this.database.connection.prepare('SELECT version FROM invitations WHERE id = ?').get(id);
    if (stored) {
      return Result.fail(new ConcurrencyConflictException('Groups', 'The invitation is already stored', { id }));
    }
    this.database.connection
      .prepare('INSERT INTO invitations (id, group_id, invited_by, version) VALUES (?, ?, ?, ?)')
      .run(id, groupId, invitedBy, version + 1);
    return Result.ok();
  }
}

function toSnapshot(row: InvitationRow): IInvitationSnapshot {
  return { _id: row.id, groupId: row.group_id, invitedBy: row.invited_by, version: row.version };
}
