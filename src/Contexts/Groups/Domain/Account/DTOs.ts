/** An account as it is stored and reconstituted: plain values, its version included. */
export interface AccountSnapshot {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  version: number;
  /** When an administrator suspended it, absent or null while it is not suspended (request 34). */
  suspendedAt?: string | null;
}
