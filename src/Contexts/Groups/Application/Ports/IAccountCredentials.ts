import { CredentialsReadModel } from '@Contexts/Groups/Application/ReadModel/CredentialsReadModel';

export interface IAccountCredentials {
  /** What proves an account, by its email as `Email` normalises it; null when no account uses it. */
  findByEmail(email: string): Promise<CredentialsReadModel | null>;
}
