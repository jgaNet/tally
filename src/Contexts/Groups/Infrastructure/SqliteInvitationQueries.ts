import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { INVITATIONS_SCHEMA } from '@Contexts/Groups/Infrastructure/SqliteInvitationRepository';
import { InvitationView, IInvitationQueries } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationQueries';

type InvitationRow = { id: string; group_id: string; group_name: string; invited_by: string };

/**
 * The read side of the invitations over SQLite: one read of the file, taken alone, outside any transaction. The group's
 * name is read with it, so an invitation reads as the link's page: which group, and who invited.
 */
export class SqliteInvitationQueries implements IInvitationQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(connection => connection.exec(INVITATIONS_SCHEMA));
  }

  async findInvitation(id: string): Promise<InvitationView | undefined> {
    return this.database.exclusive(() => {
      const row = this.database.connection
        .prepare(
          'SELECT i.id, i.group_id, g.name AS group_name, i.invited_by FROM invitations i JOIN groups g ON g.id = i.group_id WHERE i.id = ?',
        )
        .get(id) as InvitationRow | undefined;
      return row
        ? {
            id: String(row.id),
            groupId: String(row.group_id),
            groupName: String(row.group_name),
            invitedBy: String(row.invited_by),
          }
        : undefined;
    });
  }
}
