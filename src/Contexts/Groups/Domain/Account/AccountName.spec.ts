import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';
import { InvalidAccountNameException } from '@Contexts/Groups/Domain/Account/AccountExceptions';

describe('AccountName', () => {
  it('accepts a name of 1 to 60 characters and keeps it trimmed', () => {
    expect(AccountName.create('  Ada  ').data?.value).toBe('Ada');
    expect(AccountName.create('a').isSuccess()).toBe(true);
    expect(AccountName.create('x'.repeat(60)).isSuccess()).toBe(true);
  });

  it.each(['', '   ', 'x'.repeat(61)])('refuses "%s"', raw => {
    const name = AccountName.create(raw);

    expect(name.isFailure()).toBe(true);
    expect(name.error).toBeInstanceOf(InvalidAccountNameException);
  });
});
