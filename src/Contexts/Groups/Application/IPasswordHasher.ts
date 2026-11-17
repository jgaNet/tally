/**
 * Makes a password's hash and checks a password against one. The salt is random, and the work is deliberately slow, so
 * it lives behind this port and not in the domain (DOMAIN-NON-DETERMINISM): the hash it answers is a plain value the
 * decision validates and keeps.
 */
export interface IPasswordHasher {
  hash(password: string): Promise<string>;
  matches(password: string, hash: string): Promise<boolean>;
}
