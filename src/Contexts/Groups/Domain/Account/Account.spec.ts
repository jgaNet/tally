import { Email } from '@SharedKernel/Domain/Email';

import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';
import {
  AccountDeletedEvent,
  AccountRegisteredEvent,
  AccountReinstatedEvent,
  AccountSuspendedEvent,
} from '@Contexts/Groups/Domain/Account/Events/AccountEvents';

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

describe('Account suspension (request 34)', () => {
  const administrator = 'admin-1';
  const at = new Date('2026-11-18T10:00:00.000Z');

  it('is not suspended when created or read back, and suspending it records its event and one log entry', () => {
    const account = newAccount();
    account.pullDomainEvents();
    expect(account.isSuspended).toBe(false);

    expect(account.suspend({ by: administrator, at })).toBe(true);

    expect(account.isSuspended).toBe(true);
    const [event] = account.pullDomainEvents();
    expect(event).toBeInstanceOf(AccountSuspendedEvent);
    expect(event.payload).toEqual({ accountId: account.id });
    expect(account.changes).toEqual([
      {
        id: expect.any(String),
        at: '2026-11-18T10:00:00.000Z',
        by: administrator,
        action: 'suspended',
        subjectId: account.id,
      },
    ]);
  });

  it('changes nothing when it is suspended again, and nothing when it is reinstated while not suspended', () => {
    const account = newAccount();
    account.suspend({ by: administrator, at });
    account.pullDomainEvents();

    expect(account.suspend({ by: administrator, at })).toBe(false);
    expect(account.pullDomainEvents()).toEqual([]);
    expect(account.changes).toHaveLength(1);

    const fresh = newAccount();
    expect(fresh.reinstate({ by: administrator, at })).toBe(false);
    expect(fresh.changes).toEqual([]);
  });

  it('reinstates a suspended account, recording AccountReinstated and a second log entry, and keeps the flag in its snapshot', () => {
    const account = newAccount();
    account.suspend({ by: administrator, at });
    account.pullDomainEvents();

    expect(account.reinstate({ by: administrator, at })).toBe(true);
    expect(account.isSuspended).toBe(false);
    expect(account.pullDomainEvents()[0]).toBeInstanceOf(AccountReinstatedEvent);
    expect(account.changes.map(change => change.action)).toEqual(['suspended', 'reinstated']);

    const suspended = Account.fromSnapshot({ ...newAccount().toSnapshot(), suspended: true });
    expect(suspended.isSuspended).toBe(true);
    expect(suspended.toSnapshot().suspended).toBe(true);
  });

  it('is refused while it owns a group with another member, or a payment of its waits, and nothing is erased', () => {
    const account = newAccount();
    account.pullDomainEvents();

    expect(account.delete({ ownsGroupWithOtherMembers: true, paymentWaiting: false }).error?.type).toBe(
      'OwnsGroupWithMembers',
    );
    expect(account.delete({ ownsGroupWithOtherMembers: false, paymentWaiting: true }).error?.type).toBe(
      'AccountPaymentWaiting',
    );
    expect(account.isDeleted).toBe(false);
    expect(account.name).toBe('Ada');
    expect(account.pullDomainEvents()).toEqual([]);
  });

  it('erases its name, its email and its hash when it is deleted, keeps its id, and records AccountDeleted', () => {
    const account = newAccount();
    const [registered] = account.pullDomainEvents();
    const id = account.id;

    expect(account.delete({ ownsGroupWithOtherMembers: false, paymentWaiting: false }).isSuccess()).toBe(true);

    expect(account.isDeleted).toBe(true);
    expect(account.id).toBe(id);
    expect(account.name).toBe('');
    expect(account.email).toBe('');
    expect(account.toSnapshot()).toMatchObject({
      id,
      email: `deleted:${id}`,
      name: '',
      passwordHash: '',
      deleted: true,
    });
    expect(account.roleAmong(['ada@example.com'])).toBe('USER');
    const [deleted] = account.pullDomainEvents();
    expect(deleted).toBeInstanceOf(AccountDeletedEvent);
    expect(registered).toBeInstanceOf(AccountRegisteredEvent);
    expect(account.delete({ ownsGroupWithOtherMembers: false, paymentWaiting: false }).error?.type).toBe('NotFound');

    const read = Account.fromSnapshot(account.toSnapshot());
    expect(read.isDeleted).toBe(true);
    expect(read.pullDomainEvents()).toEqual([]);
  });
});
