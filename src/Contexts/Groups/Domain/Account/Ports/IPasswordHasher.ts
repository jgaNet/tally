/**
 * Hashing a password has a business meaning: an account keeps only what proves its password, never the
 * password. The algorithm is not the domain's, so it sits behind this port, implemented in the infrastructure.
 */
export interface IPasswordHasher {
  /** The hash to keep for this password. */
  hash(password: string): Promise<string>;
  /** Whether this password is the one the hash was made of. */
  verify(password: string, hash: string): Promise<boolean>;
}
