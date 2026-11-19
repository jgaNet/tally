import { Role } from '@SharedKernel/Domain';

/**
 * The role an account is given at sign-in (request 33, ADR 24): an administrator when its email is one of the ADMIN_EMAILS the
 * server was started with, whatever the case of either; a user otherwise. Nothing in the API makes one. It is decided here, by
 * the account's own email, so the composition root only hands over the list.
 */
export function roleAtSignIn(email: string, administratorEmails: readonly string[]): Role {
  const normalized = email.trim().toLowerCase();
  return administratorEmails.some(administrator => administrator.trim().toLowerCase() === normalized)
    ? Role.ADMIN
    : Role.USER;
}
