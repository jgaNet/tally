/** What `GetMyAccount` answers: an account as its owner reads it. */
export interface AccountView {
  id: string;
  email: string;
  name: string;
}

/** The read side of the accounts: read models, never aggregates (QUERY-READ-MODELS). */
export interface IAccountQueries {
  accountOf(id: string): Promise<AccountView | undefined>;
}
