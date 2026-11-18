/**
 * Who is an administrator (request 33): the accounts whose email is in the list the server is started with (`ADMIN_EMAILS`, emails
 * separated by commas), whatever its case. Nobody becomes one through the API: the list is the server's, read where the server is
 * started, and an account is an administrator for as long as its email is in it.
 */
export class Administrators {
  readonly #emails: Set<string>;

  private constructor(emails: Set<string>) {
    this.#emails = emails;
  }

  /** The administrators a list names: emails separated by commas, trimmed, case ignored; an unset or empty list names none. */
  static fromList(list: string | undefined): Administrators {
    const emails = (list ?? '')
      .split(',')
      .map(email => email.trim().toLowerCase())
      .filter(email => email.length > 0);
    return new Administrators(new Set(emails));
  }

  /** Whether the account with this email is an administrator. */
  includes(email: string): boolean {
    return this.#emails.has(email.trim().toLowerCase());
  }

  get isEmpty(): boolean {
    return this.#emails.size === 0;
  }
}
