/**
 * What an account is made of, as it is kept; `suspendedAt` is set while an administrator has suspended it (request 34); `deletedAt` once its
 * person deleted it (request 35), when its email is null, its name is the placeholder and its password hash is empty; `version` is the one
 * it was read at.
 */
export interface AccountSnapshot {
  id: string;
  email: string | null;
  name: string;
  passwordHash: string;
  suspendedAt: string | null;
  deletedAt: string | null;
  version: number;
}
