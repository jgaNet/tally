import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IInvitationQueries, InvitationView } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationQueries';
import { createInvitationsTable } from '@Contexts/Groups/Infrastructure/Repositories/SqliteInvitationRepository';
import { createGroupsTables } from '@Contexts/Groups/Infrastructure/Repositories/SqliteGroupRepository';

interface InvitationViewRow {
  id: string;
  group_id: string;
  name: string;
  invited_by: string;
}

/** The read side of invitations over the same file: the invitation with its group's name, read as the link is. */
export class SqliteInvitationQueries implements IInvitationQueries {
  constructor(private database: SqliteDatabase) {
    createGroupsTables(database);
    createInvitationsTable(database);
  }

  findInvitation(id: string): Promise<InvitationView | null> {
    return this.database.exclusive(connection => {
      const row = connection
        .prepare(
          `SELECT i.id, i.group_id, g.name, i.invited_by FROM invitations i
           JOIN groups g ON g.id = i.group_id WHERE i.id = ?`,
        )
        .get(id) as InvitationViewRow | undefined;
      return row ? { id: row.id, groupId: row.group_id, groupName: row.name, invitedBy: row.invited_by } : null;
    });
  }
}
