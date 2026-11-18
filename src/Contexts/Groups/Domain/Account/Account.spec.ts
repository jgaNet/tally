import { IResult } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';

import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';
import {
  EmailAlreadyRegisteredException,
  PasswordTooShortException,
} from '@Contexts/Groups/Domain/Account/AccountExceptions';
import { AccountRegistration } from '@Contexts/Groups/Domain/Account/AccountRegistration';
import { Password } from '@Contexts/Groups/Domain/Account/Password';
import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { IPasswordHasher } from '@Contexts/Groups/Domain/Account/Ports/IPasswordHasher';

const valueOf = <T>(result: IResult<T>): T => {
  if (result.isFailure()) throw result.error;
  return result.data as T;
};

const ana = () =>
  Account.create({
    email: valueOf(Email.create('ana@example.com')),
    name: valueOf(AccountName.create('Ana')),
    passwordHash: 'hash',
  });

describe('Account', () => {
  it('is opened with an id it generates, and records its registration once', () => {
    const account = ana();

    expect(account._id.value).toEqual(expect.any(String));
    expect(account.version).toBe(0);
    expect(account.toSnapshot()).toMatchObject({ email: 'ana@example.com', name: 'Ana', passwordHash: 'hash' });
  });

  it('is rebuilt from its snapshot as it was, at the version it was saved at', () => {
    const snapshot = { ...ana().toSnapshot(), version: 3 };
    const rebuilt = Account.fromSnapshot(snapshot);

    expect(rebuilt.toSnapshot()).toEqual(snapshot);
    expect(rebuilt.version).toBe(3);
  });

  it('refuses to be rebuilt from a snapshot with a corrupted email', () => {
    expect(() => Account.fromSnapshot({ ...ana().toSnapshot(), email: 'not-an-email' })).toThrow('Corrupted account');
  });
});

describe('AccountName', () => {
  it('accepts 1 to 60 characters, kept trimmed', () => {
    expect(valueOf(AccountName.create('  Ana  '))?.value).toBe('Ana');
    expect(AccountName.create('x'.repeat(60)).isSuccess()).toBe(true);
  });

  it('refuses an empty name, one that is only spaces, and one longer than 60 characters', () => {
    expect(AccountName.create('').isFailure()).toBe(true);
    expect(AccountName.create('   ').isFailure()).toBe(true);
    expect(AccountName.create('x'.repeat(61)).isFailure()).toBe(true);
  });
});

describe('Password', () => {
  it('accepts at least 8 characters, and refuses fewer', () => {
    expect(Password.create('12345678').isSuccess()).toBe(true);
    const short = Password.create('1234567');
    expect(short.isFailure() && short.error).toBeInstanceOf(PasswordTooShortException);
  });
});

describe('AccountRegistration', () => {
  const taken = new Set<string>();
  const accounts: IAccountRepository = {
    findById: async () => null,
    findByEmail: async email => (taken.has(email.value) ? ana() : null),
    save: async () => ({ isSuccess: () => true, isFailure: () => false }) as never,
  };
  const hasher: IPasswordHasher = {
    hash: async password => `hashed:${password}`,
    verify: async () => true,
  };
  const registration = new AccountRegistration(accounts, hasher);

  beforeEach(() => taken.clear());

  it('opens an account with the password hashed, and records its registration', async () => {
    const decided = await registration.register({ email: 'Bo@Example.com', name: 'Bo', password: 'correct horse' });

    expect(decided.isSuccess()).toBe(true);
    expect(decided.isSuccess() && decided.data.toSnapshot()).toMatchObject({
      email: 'bo@example.com',
      name: 'Bo',
      passwordHash: 'hashed:correct horse',
    });
  });

  it('refuses an email another account uses', async () => {
    taken.add('ana@example.com');
    const decided = await registration.register({ email: 'ANA@example.com', name: 'Ana 2', password: 'correct horse' });

    expect(decided.isFailure() && decided.error).toBeInstanceOf(EmailAlreadyRegisteredException);
  });

  it('refuses a short password before it asks about the email', async () => {
    const decided = await registration.register({ email: 'new@example.com', name: 'New', password: 'short' });

    expect(decided.isFailure() && decided.error).toBeInstanceOf(PasswordTooShortException);
  });
});

describe('Account deletion (request 35)', () => {
  const at = new Date('2026-11-18T10:00:00.000Z');

  it('is refused while it owns a group with another member, or a payment waits, and nothing changes', () => {
    const account = ana();
    const before = account.toSnapshot();

    expect(account.delete({ at, ownsGroupWithMembers: true, paymentOpen: false }).isFailure()).toBe(true);
    expect(account.delete({ at, ownsGroupWithMembers: false, paymentOpen: true }).isFailure()).toBe(true);
    expect(account.toSnapshot()).toEqual(before);
    expect(account.isDeleted).toBe(false);
  });

  it('erases its email and password, names it Deleted account, and keeps its id', () => {
    const account = ana();
    const id = account._id.value;

    expect(account.delete({ at, ownsGroupWithMembers: false, paymentOpen: false }).isSuccess()).toBe(true);

    expect(account.toSnapshot()).toMatchObject({
      _id: id,
      email: null,
      name: 'Deleted account',
      passwordHash: '',
      deletedAt: at.toISOString(),
    });
    expect(account.isDeleted).toBe(true);
  });

  it('is rebuilt deleted from its snapshot, and is not found a second time', () => {
    const account = ana();
    account.delete({ at, ownsGroupWithMembers: false, paymentOpen: false });
    const rebuilt = Account.fromSnapshot(account.toSnapshot());

    expect(rebuilt.isDeleted).toBe(true);
    expect(rebuilt.delete({ at, ownsGroupWithMembers: false, paymentOpen: false }).isFailure()).toBe(true);
  });

  it('is not suspended by an administrator once deleted: the suspension changes nothing', () => {
    const account = ana();
    account.delete({ at, ownsGroupWithMembers: false, paymentOpen: false });

    expect(account.suspend(at)).toBe(false);
    expect(account.isSuspended).toBe(false);
  });
});
