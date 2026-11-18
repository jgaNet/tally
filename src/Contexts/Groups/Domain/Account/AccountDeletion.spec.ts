import { describe, expect, it } from '@jest/globals';

import { Account } from '@Contexts/Groups/Domain/Account/Account';

const now = new Date('2026-01-01T00:00:00.000Z');
const free = { ownsGroupWithOthers: false, paymentWaiting: false };

const signedUp = (): Account => {
  const created = Account.create(
    { email: 'ann@example.com', password: 'a long enough password', passwordHash: 'hash', name: 'Ann' },
    { emailTaken: false },
    now,
  );
  if (created.isFailure()) throw new Error('the fixture is a valid sign-up');
  return created.data;
};

describe('Account.delete (feature 35)', () => {
  it('erases the email, the name and the password, keeps the id, and is deleted from then on', () => {
    const ann = signedUp();
    const id = ann.toSnapshot().id;

    expect(ann.delete(free, now).isSuccess()).toBe(true);

    expect(ann.isDeleted()).toBe(true);
    expect(ann.toSnapshot()).toEqual({ id, version: 0, deletedAt: now.toISOString() });
  });

  it('is refused while the account owns a group that has another member, and changes nothing', () => {
    const ann = signedUp();

    const refused = ann.delete({ ...free, ownsGroupWithOthers: true }, now);

    expect(refused.isFailure()).toBe(true);
    expect(ann.isDeleted()).toBe(false);
    expect(ann.toSnapshot()).toMatchObject({ email: 'ann@example.com', name: 'Ann', passwordHash: 'hash' });
  });

  it('is refused while a payment through the provider the account pays or receives waits, and changes nothing', () => {
    const ann = signedUp();

    const refused = ann.delete({ ...free, paymentWaiting: true }, now);

    expect(refused.isFailure()).toBe(true);
    expect(ann.isDeleted()).toBe(false);
  });

  it('is rebuilt from its snapshot as deleted, with no email, name or password left to sign in with', () => {
    const rebuilt = Account.fromSnapshot({ id: 'a-1', version: 2, deletedAt: now.toISOString() });

    expect(rebuilt.isDeleted()).toBe(true);
    expect(rebuilt.toSnapshot()).toEqual({ id: 'a-1', version: 2, deletedAt: now.toISOString() });
  });
});
