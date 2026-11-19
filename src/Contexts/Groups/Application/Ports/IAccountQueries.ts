import { AccountReadModel, AccountCredentials } from '@Contexts/Groups/Application/ReadModel/AccountReadModel';

export interface IAccountQueries {
  /** The account of this id, or null for an id nobody has. */
  findById(id: string): Promise<AccountReadModel | null>;
  /** Whether the account of this id was deleted by its person (request 35): a token it was given proves nothing then. */
  isDeleted(id: string): Promise<boolean>;
  /** What signing in checks, for the account that uses this email (any case), or null. */
  findCredentials(email: string): Promise<AccountCredentials | null>;
}
