/**
 * What the domain cannot decide for itself: a password's hash is salted at random, and checking
 * one is a computation the aggregate has no business knowing (DOMAIN-NON-DETERMINISM). The
 * result is a plain string the Account keeps as given.
 */
export interface IPasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}
