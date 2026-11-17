import { InvitationReadModel } from '@Contexts/Groups/Application/ReadModel/InvitationReadModel';

export interface IInvitationQueries {
  /** The invitation of this id, with its group's id and name; null when there is none. Any signed-in person may read it. */
  findById(id: string): Promise<InvitationReadModel | null>;
}
