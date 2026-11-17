import { Email } from '@SharedKernel/Domain/Email';

import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';
import { AccountRegisteredEvent } from '@Contexts/Groups/Domain/Account/Events/AccountEvents';

const newAccount = () =>
  Account.create({
    email: Email.create('Ada@Example.com').data as Email,
    name: AccountName.create('Ada').data as AccountName,
    passwordHash: 'scrypt$salt$key',
  });

describe('Account', () => {
  it('is created with a generated id, the email in lower case, the name, and version 0', () => {
    const account = newAccount();

    expect(account.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(account.email).toBe('ada@example.com');
    expect(account.name).toBe('Ada');
    expect(account.version).toBe(0);
  });

  it('records AccountRegistered when it is created, and nothing when it is read back', () => {
    const account = newAccount();
    const [event] = account.pullDomainEvents();

    expect(event).toBeInstanceOf(AccountRegisteredEvent);
    expect(event.payload).toEqual({ accountId: account.id, name: 'Ada' });

    const read = Account.fromSnapshot({ ...account.toSnapshot(), version: 3 });
    expect(read.pullDomainEvents()).toEqual([]);
  });

  it('round-trips through its snapshot, version included', () => {
    const snapshot = { ...newAccount().toSnapshot(), version: 2 };

    expect(Account.fromSnapshot(snapshot).toSnapshot()).toEqual(snapshot);
  });

  it('refuses to be read back from corrupted data', () => {
    const snapshot = newAccount().toSnapshot();

    expect(() => Account.fromSnapshot({ ...snapshot, email: 'not-an-email' })).toThrow(/corrupted/);
    expect(() => Account.fromSnapshot({ ...snapshot, passwordHash: '' })).toThrow(/corrupted/);
  });
});
