import { Role } from '@SharedKernel/Domain';

/**
 * Who is an administrator (the storm's first hot spot, request 33): the account whose email is one of the emails the server was
 * started with (ADMIN_EMAILS), whatever its case. The role is decided here, at sign-in, and travels in the token the account is given;
 * no command makes an administrator, and an administrator signs up and signs in as anyone does.
 */
export const roleOf = (email: string, administrators: readonly string[]): Role =>
  administrators.includes(email.trim().toLowerCase()) ? Role.ADMIN : Role.USER;

/** The emails an ADMIN_EMAILS setting names, separated by commas, in lower case; an empty entry names nobody. */
export const administratorsIn = (setting: string): string[] =>
  setting
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry.length > 0);
