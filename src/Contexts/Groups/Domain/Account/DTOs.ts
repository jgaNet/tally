/** An account as it is stored and reconstituted: plain values, its version included. */
export interface AccountSnapshot {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  version: number;
}
