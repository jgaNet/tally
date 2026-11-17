/**
 * Hashes a password with a fresh salt, and checks one against a stored hash. Randomness and the cost of the
 * computation are the infrastructure's; the domain only ever holds the hash, as a value.
 */
export interface IPasswordHasher {
  hash(password: string): Promise<string>;
  /** `undefined` is no account: the same work is done, and the answer is `false`. */
  matches(password: string, hash: string | undefined): Promise<boolean>;
}
