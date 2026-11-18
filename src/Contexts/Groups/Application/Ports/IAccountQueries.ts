import { AccountReadModel } from '@Contexts/Groups/Application/ReadModel/AccountReadModel';

export interface IAccountQueries {
  /** The account with this id, or null when there is none. */
  findById(id: string): Promise<AccountReadModel | null>;
  /** Whether the person deleted the account (request 35): a token it was given proves nothing any more. False for an id no account has. */
  isDeleted(id: string): Promise<boolean>;
}
