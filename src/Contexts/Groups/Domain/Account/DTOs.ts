/** What an account is made of, as it is kept; `suspendedAt` is set while an administrator has suspended it (request 34); `version` is the one it was read at. */
export interface AccountSnapshot {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  suspendedAt: string | null;
  version: number;
}
