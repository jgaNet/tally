import { AdministratorChange } from '@Contexts/Groups/Domain/Account/DTOs';

/**
 * The administrators' log of the changes Groups makes to accounts (request 34, docs/adr/0034): each suspension and reinstatement, written
 * with the change, the oldest first. Groups' own: it reads it from the store it writes it to. Only an administrator reads it, through
 * `GetAdministratorsLog`, which answers it with the decisions Settlements keeps (`IAdministratorDecisions`).
 */
export interface IAdministratorChanges {
  changesOf(): Promise<AdministratorChange[]>;
}
