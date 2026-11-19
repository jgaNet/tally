/** An account as it is stored and reconstituted: plain values, its version included. */
export interface AccountSnapshot {
  id: string;
  /** Null once the account is deleted (request 35): its email is erased. */
  email: string | null;
  name: string;
  passwordHash: string;
  version: number;
  /** When an administrator suspended it, absent or null while it is not suspended (request 34). */
  suspendedAt?: string | null;
  /** When its person deleted it, absent or null while it is not deleted (request 35). */
  deletedAt?: string | null;
}
