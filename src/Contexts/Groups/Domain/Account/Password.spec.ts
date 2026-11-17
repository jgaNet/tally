import { Password } from '@Contexts/Groups/Domain/Account/Password';
import { PasswordTooShortException } from '@Contexts/Groups/Domain/Account/AccountExceptions';

describe('Password', () => {
  it('accepts eight characters or more, as typed', () => {
    expect(Password.create('12345678').data?.value).toBe('12345678');
    expect(Password.create('  spaces  ').isSuccess()).toBe(true);
  });

  it('refuses fewer than eight characters', () => {
    const password = Password.create('1234567');

    expect(password.isFailure()).toBe(true);
    expect(password.error).toBeInstanceOf(PasswordTooShortException);
  });
});
