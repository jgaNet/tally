import { Refusal } from '../refusal';

export interface Signup {
  /** As typed, trimmed. */
  email: string;
  password: string;
  /** Trimmed; what the other people of the account's groups see. */
  name: string;
}

// Something, an `@`, then something with a dot in it. Deliberately loose: it only has to tell
// an email from a typo, and a mailbox is the only real test.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Length in characters (code points), not UTF-16 units. */
const charLength = (text: string): number => [...text].length;

/** Checks a sign-up. Refusals are `422`: the body had the right shape, a value is not allowed. */
export function validateSignup(input: { email: string; password: string; name: string }): Signup {
  const email = input.email.trim();
  if (!EMAIL.test(email)) {
    throw new Refusal(422, 'InvalidEmail', 'The email must look like an email address.');
  }

  if (charLength(input.password) < 8) {
    throw new Refusal(422, 'PasswordTooShort', 'The password must have at least 8 characters.');
  }

  const name = input.name.trim();
  if (charLength(name) < 1 || charLength(name) > 60) {
    throw new Refusal(422, 'InvalidName', 'The name must have between 1 and 60 characters, not only spaces.');
  }

  return { email, password: input.password, name };
}

/** The form an email is compared in: an email already used is refused whatever its case. */
export const emailKey = (email: string): string => email.toLowerCase();
