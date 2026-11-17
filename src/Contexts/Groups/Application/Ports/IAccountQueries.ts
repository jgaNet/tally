import { AccountReadModel } from '@Contexts/Groups/Application/ReadModel/AccountReadModel';

export interface IAccountQueries {
  /** The account with this id, or null when there is none. */
  findById(id: string): Promise<AccountReadModel | null>;
}
