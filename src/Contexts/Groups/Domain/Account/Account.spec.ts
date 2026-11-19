import { Email } from '@SharedKernel/Domain';
import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';
import { Password } from '@Contexts/Groups/Domain/Account/Password';
import { InvalidAccountName, InvalidPassword } from '@Contexts/Groups/Domain/Account/AccountExceptions';
import {
  AccountDeletedEvent,
  AccountReinstatedEvent,
  AccountRegisteredEvent,
  AccountSuspendedEvent,
} from '@Contexts/Groups/Domain/Account/Events/AccountEvents';

const email = Email.create('alice@example.com').data as Email;
const name = AccountName.create('Alice').data as AccountName;

describe('Account', () => {
  it('registers with a generated id, and records that it was registered', () => {
    const account = Account.register({ email, name, passwordHash: 'hash' });
    expect(account._id.value).toMatch(/^[0-9a-f-]{36}$/);
    expect(account.version).toBe(0);
    const [event] = account.pullDomainEvents();
    expect(event).toBeInstanceOf(AccountRegisteredEvent);
    expect(event.payload).toEqual({ accountId: account._id.value, email: 'alice@example.com', name: 'Alice' });
  });

  it('is reconstituted from its snapshot without recording anything', () => {
    const account = Account.register({ email, name, passwordHash: 'hash' });
    const copy = Account.fromSnapshot({ ...account.toSnapshot(), version: 3 });
    expect(copy.toSnapshot()).toEqual({ ...account.toSnapshot(), version: 3 });
    expect(copy.pullDomainEvents()).toEqual([]);
  });

  it('refuses a corrupted snapshot by throwing', () => {
    expect(() => Account.fromSnapshot({ id: 'x', email: 'nope', name: 'A', passwordHash: 'h', version: 0 })).toThrow();
  });
});

describe('Password', () => {
  it.each([
    ['1234567', false],
    ['12345678', true],
  ])('%s is accepted: %s', (raw, accepted) => {
    expect(Password.create(raw).isSuccess()).toBe(accepted);
  });
  it('is refused with its rule', () => {
    expect(Password.create('short').error).toBeInstanceOf(InvalidPassword);
  });
});

describe('AccountName', () => {
  it.each([
    ['', false],
    ['   ', false],
    ['A', true],
    ['a'.repeat(60), true],
    ['a'.repeat(61), false],
  ])('"%s" is accepted: %s', (raw, accepted) => {
    expect(AccountName.create(raw).isSuccess()).toBe(accepted);
  });
  it('is refused with its rule', () => {
    expect(AccountName.create(' ').error).toBeInstanceOf(InvalidAccountName);
  });
});

describe('Account suspension (request 34)', () => {
  const at = new Date('2026-05-01T10:00:00.000Z');
  const later = new Date('2026-05-02T10:00:00.000Z');

  it('is suspended once, recording AccountSuspended, and changes nothing when it is suspended again', () => {
    const account = Account.register({ email, name, passwordHash: 'hash' });
    account.pullDomainEvents();
    expect(account.isSuspended).toBe(false);

    expect(account.suspend({ at })).toBe(true);
    expect(account.isSuspended).toBe(true);
    expect(account.suspendedAt).toEqual(at);
    expect(account.suspend({ at: later })).toBe(false);
    expect(account.suspendedAt).toEqual(at);

    const events = account.pullDomainEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(AccountSuspendedEvent);
    expect(events[0].payload).toEqual({ accountId: account._id.value, suspendedAt: at.toISOString() });
  });

  it('is reinstated once, recording AccountReinstated, and changes nothing when it is not suspended', () => {
    const account = Account.register({ email, name, passwordHash: 'hash' });
    account.pullDomainEvents();
    expect(account.reinstate({ at })).toBe(false);
    expect(account.pullDomainEvents()).toEqual([]);

    account.suspend({ at });
    account.pullDomainEvents();
    expect(account.reinstate({ at: later })).toBe(true);
    expect(account.isSuspended).toBe(false);
    const [event] = account.pullDomainEvents();
    expect(event).toBeInstanceOf(AccountReinstatedEvent);
    expect(event.payload).toEqual({ accountId: account._id.value, reinstatedAt: later.toISOString() });
  });

  it('keeps its suspension through a snapshot, and reads a snapshot with no suspension as not suspended', () => {
    const account = Account.register({ email, name, passwordHash: 'hash' });
    account.suspend({ at });
    const copy = Account.fromSnapshot({ ...account.toSnapshot(), version: 2 });
    expect(copy.isSuspended).toBe(true);
    expect(copy.suspendedAt).toEqual(at);
    expect(copy.pullDomainEvents()).toEqual([]);
    expect(Account.fromSnapshot({ ...account.toSnapshot(), suspendedAt: null }).isSuspended).toBe(false);
  });

  describe('deleting it (request 35)', () => {
    const free = { ownsAGroupWithMembers: false, paymentWaiting: false };

    it('erases its email, its name and its password, keeps its id, and records that it was deleted', () => {
      const account = Account.register({ email, name, passwordHash: 'hash' });
      account.pullDomainEvents();
      expect(account.delete({ at, ...free }).isSuccess()).toBe(true);
      expect(account.isDeleted).toBe(true);
      expect(account.email).toBeNull();
      expect(account.name.value).toBe('Deleted account');
      expect(account.passwordHash).toBe('');
      const [event] = account.pullDomainEvents();
      expect(event).toBeInstanceOf(AccountDeletedEvent);
      expect(event.payload).toEqual({ accountId: account._id.value, deletedAt: at.toISOString() });
    });

    it('is refused, and changes nothing, while it owns a group that has another member or a payment waits', () => {
      const account = Account.register({ email, name, passwordHash: 'hash' });
      account.pullDomainEvents();
      const owner = account.delete({ at, ownsAGroupWithMembers: true, paymentWaiting: false });
      expect(owner.isFailure() && owner.error.type).toBe('AccountOwnsAGroupWithMembers');
      const waiting = account.delete({ at, ownsAGroupWithMembers: false, paymentWaiting: true });
      expect(waiting.isFailure() && waiting.error.type).toBe('PaymentWaitingAtProvider');
      expect(account.isDeleted).toBe(false);
      expect(account.email?.value).toBe('alice@example.com');
      expect(account.pullDomainEvents()).toEqual([]);
    });

    it('records nothing when it is already deleted, and survives a snapshot as deleted', () => {
      const account = Account.register({ email, name, passwordHash: 'hash' });
      account.delete({ at, ...free });
      account.pullDomainEvents();
      expect(account.delete({ at: later, ...free }).isSuccess()).toBe(true);
      expect(account.pullDomainEvents()).toEqual([]);
      const copy = Account.fromSnapshot({ ...account.toSnapshot(), version: 2 });
      expect(copy.isDeleted).toBe(true);
      expect(copy.deletedAt).toEqual(at);
      expect(copy.email).toBeNull();
      expect(copy.toSnapshot()).toMatchObject({ email: null, name: 'Deleted account', passwordHash: '' });
    });
  });
});
