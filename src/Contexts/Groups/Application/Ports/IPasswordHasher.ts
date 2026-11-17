/**
 * Keeps a password as something that does not reveal it, and checks a password against what was kept.
 * Hashing takes randomness (a salt), which is why it is a port and not a function of the business state
 * (DOMAIN-NON-DETERMINISM).
 */
export interface IPasswordHasher {
  hash(password: string): Promise<string>;
  matches(password: string, hash: string): Promise<boolean>;
}
