import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IInvitationQueries } from '@Contexts/Groups/Application/Ports/IInvitationQueries';
import { InvitationReadModel } from '@Contexts/Groups/Application/ReadModel/InvitationReadModel';
import { createGroupsTables } from '@Contexts/Groups/Infrastructure/GroupsTables';

interface Row {
  id: string;
  group_id: string;
  group_name: string;
  invited_by: string;
}

/** The invitations as anyone who holds the link reads them: what is read outside any transaction, so it waits for the one in progress. */
export class PostgresInvitationReadModels implements IInvitationQueries {
  constructor(private database: PostgresDatabase) {
    createGroupsTables(database);
  }

  async findById(invitationId: string): Promise<InvitationReadModel | null> {
    const row = await this.database.exclusive(
      async () =>
        await this.database.get<Row>(
          `SELECT i.id AS id, i.group_id AS group_id, g.name AS group_name, i.invited_by AS invited_by
         FROM invitations i JOIN groups g ON g.id = i.group_id WHERE i.id = ?`,
          invitationId,
        ),
    );
    return row ? { id: row.id, groupId: row.group_id, groupName: row.group_name, invitedBy: row.invited_by } : null;
  }
}
