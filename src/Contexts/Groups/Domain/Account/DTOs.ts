/** What an account is made of, as it is kept; `version` is the one it was read at. */
export interface AccountSnapshot {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  version: number;
}
