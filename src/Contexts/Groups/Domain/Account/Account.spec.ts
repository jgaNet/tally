import { Email } from '@SharedKernel/Domain';

import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { Name } from '@Contexts/Groups/Domain/Account/Name';
import { Password } from '@Contexts/Groups/Domain/Account/Password';
import { AccountDeletedEvent, AccountRegisteredEvent } from '@Contexts/Groups/Domain/Account/Events/AccountEvents';

const register = () =>
  Account.register({
    email: Email.create('Alice@Example.com').data as Email,
    name: Name.create('Alice').data as Name,
    passwordHash: 'hash',
  });

describe('Account', () => {
  it('is born with its own id and says that it was registered', () => {
    const account = register();

    expect(account._id.value).toEqual(expect.any(String));
    expect(account.version).toBe(0);
    expect(account.pullDomainEvents()).toEqual([
      expect.objectContaining({
        name: AccountRegisteredEvent.name,
        payload: { accountId: account._id.value, name: 'Alice' },
      }),
    ]);
  });

  it('comes back from its snapshot, recording nothing', () => {
    const account = register();

    const again = Account.fromSnapshot({ ...account.toSnapshot(), version: 3 });

    expect(again.toSnapshot()).toEqual({ ...account.toSnapshot(), version: 3 });
    expect(again.email?.value).toBe('alice@example.com');
    expect(again.pullDomainEvents()).toEqual([]);
  });

  it('throws on a corrupted snapshot', () => {
    expect(() => Account.fromSnapshot({ ...register().toSnapshot(), email: 'nope' })).toThrow();
  });
});

describe('Account deletion (request 35)', () => {
  const clear = { ownedWithOthers: false, paymentWaiting: false, now: new Date('2026-04-01T10:00:00.000Z') };

  it('erases the email, the name and the password, keeps the id, and records that it was deleted', () => {
    const account = register();
    account.pullDomainEvents();

    expect(account.delete(clear).isSuccess()).toBe(true);

    expect(account.isDeleted()).toBe(true);
    expect(account.toSnapshot()).toEqual({
      id: account._id.value,
      email: null,
      name: 'Deleted account',
      passwordHash: '',
      suspendedAt: null,
      deletedAt: '2026-04-01T10:00:00.000Z',
      version: 0,
    });
    expect(account.pullDomainEvents()).toEqual([
      expect.objectContaining({
        name: AccountDeletedEvent.name,
        payload: { accountId: account._id.value, at: '2026-04-01T10:00:00.000Z' },
      }),
    ]);
  });

  it.each([
    [{ ownedWithOthers: true }, 'OwnsAGroupWithOtherMembers'],
    [{ paymentWaiting: true }, 'PaymentWaitingAtTheProvider'],
  ])('is refused, and nothing changes, when %j', (reason, type) => {
    const account = register();
    account.pullDomainEvents();

    const refused = account.delete({ ...clear, ...reason });

    expect(refused.isFailure() && refused.error.type).toBe(type);
    expect(account.isDeleted()).toBe(false);
    expect(account.email?.value).toBe('alice@example.com');
    expect(account.pullDomainEvents()).toEqual([]);
  });

  it('comes back from its snapshot as deleted, and is left as it is when deleted again', () => {
    const account = register();
    account.delete(clear);
    const again = Account.fromSnapshot({ ...account.toSnapshot(), version: 2 });

    expect(again.isDeleted()).toBe(true);
    expect(again.delete(clear).isSuccess()).toBe(true);
    expect(again.pullDomainEvents()).toEqual([]);
  });

  it('throws on a deleted snapshot that still holds an email', () => {
    const account = register();
    account.delete(clear);

    expect(() => Account.fromSnapshot({ ...account.toSnapshot(), email: 'alice@example.com' })).toThrow();
  });
});

describe('Name', () => {
  it.each(['A', 'Alice Martin', 'x'.repeat(60), '  Al  ', 'é'.repeat(60)])('accepts "%s"', raw => {
    expect(Name.create(raw).isSuccess()).toBe(true);
  });

  it.each(['', '   ', '\t\n', 'x'.repeat(61)])('refuses %j', raw => {
    const name = Name.create(raw);
    expect(name.isFailure() && name.error.type).toBe('InvalidName');
  });
});

describe('Password', () => {
  it('has at least 8 characters', () => {
    expect(Password.create('12345678').isSuccess()).toBe(true);
    const short = Password.create('1234567');
    expect(short.isFailure() && short.error.type).toBe('PasswordTooShort');
  });
});
