/**
 * What the machine decides about a password: a hash is salted by chance, so it is not a function of the password,
 * and checking one costs what an attacker pays for each guess.
 */
export interface IPasswordHasher {
  hash(password: string): string;
  matches(password: string, hash: string): boolean;
}
