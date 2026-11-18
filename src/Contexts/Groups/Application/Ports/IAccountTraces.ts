/**
 * What Groups kept of an account's name and email outside the account itself, in the facts a sign-up left (the event that announced it, the
 * command that asked for it): erased in the transaction of the deletion, so that nothing Tally keeps holds them afterwards (request 35). It
 * is given what the account held before it was erased, to find them by: its id, and its email as the account kept it.
 */
export interface IAccountTraces {
  erase(account: { accountId: string; email: string | null }): Promise<void>;
}
