import type { Account } from '../accounts/accounts';
import { emailKey } from '../accounts/validation';

/**
 * The administrators, from `ADMIN_EMAILS`: a list of emails separated by commas. Their case does not matter, nor the
 * spaces around them; an empty entry is none. The set is read once, when the application starts.
 */
export function administratorsOf(list: string): ReadonlySet<string> {
  return new Set(
    list
      .split(',')
      .map(email => emailKey(email.trim()))
      .filter(email => email !== ''),
  );
}

/** Whether `account` is an administrator: its email, whatever its case, is one of the set. Nobody becomes one through the API. */
export function isAdministrator(administrators: ReadonlySet<string>, account: Account): boolean {
  return administrators.has(emailKey(account.email.trim()));
}
