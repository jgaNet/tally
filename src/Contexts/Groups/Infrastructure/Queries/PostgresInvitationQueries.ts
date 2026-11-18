import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IInvitationQueries, InvitationView } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationQueries';
import { createInvitationsTable } from '@Contexts/Groups/Infrastructure/Repositories/PostgresInvitationRepository';
import { createGroupsTables } from '@Contexts/Groups/Infrastructure/Repositories/PostgresGroupRepository';

interface InvitationViewRow {
  id: string;
  group_id: string;
  name: string;
  invited_by: string;
}

/** The read side of invitations over the same database: the invitation with its group's name, read as the link is. */
export class PostgresInvitationQueries implements IInvitationQueries {
  constructor(private database: PostgresDatabase) {
    createGroupsTables(database);
    createInvitationsTable(database);
  }

  async findInvitation(id: string): Promise<InvitationView | null> {
    const row = await this.database.get<InvitationViewRow>(
      `SELECT i.id, i.group_id, g.name, i.invited_by FROM invitations i
       JOIN groups g ON g.id = i.group_id WHERE i.id = ?`,
      [id],
    );
    return row ? { id: row.id, groupId: row.group_id, groupName: row.name, invitedBy: row.invited_by } : null;
  }
}
