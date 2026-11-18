import type { Account } from './accounts';

/**
 * The administrators of the platform, by email: the emails the server is started with (`ADMIN_EMAILS`, a list separated
 * by commas). An account with one of them, whatever its case, is an administrator. Nobody becomes one through the API.
 * An empty value, or none, means there are no administrators.
 */
export function administratorEmailsOf(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map(email => email.trim().toLowerCase())
      .filter(email => email !== ''),
  );
}

/** True when `account` is one of the administrators, whose email is compared whatever its case. */
export function isAdministrator(administrators: ReadonlySet<string>, account: Pick<Account, 'email'>): boolean {
  return administrators.has(account.email.toLowerCase());
}
