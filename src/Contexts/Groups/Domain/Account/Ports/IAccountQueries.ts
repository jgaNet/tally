/** What a signed-in person reads of their own account: a read model, never the aggregate (QUERY-READ-MODELS). */
export interface AccountView {
  id: string;
  email: string;
  name: string;
}

/** The read side of the accounts' store: what a query answers, read at once. */
export interface IAccountQueries {
  /** The account with this id, or undefined when there is none. */
  findAccount(id: string): Promise<AccountView | undefined>;
  /**
   * Whether the person deleted the account (request 35, docs/adr/0035). False for an account that does not exist. A token of a deleted
   * account proves nothing: the transport asks it before it accepts the token.
   */
  isDeleted(id: string): Promise<boolean>;
}
