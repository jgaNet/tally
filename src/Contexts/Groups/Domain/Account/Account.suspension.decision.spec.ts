import { Account } from './Account';
import { decideReinstateAccount, decideSuspendAccount } from './Account.decision';

/** Request 34: an administrator suspends an account and reinstates it; a change to the state it is in already changes nothing and logs nothing. */
const at = new Date('2026-03-01T10:00:00.000Z');
const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
const active = () => Account.fromSnapshot({ id, email: 'ada@example.org', name: 'Ada', passwordHash: 'hash' });
const suspended = () =>
  Account.fromSnapshot({
    id,
    email: 'ada@example.org',
    name: 'Ada',
    passwordHash: 'hash',
    suspendedAt: '2026-02-01T00:00:00.000Z',
  });
const admin = { by: 'root', administrator: true };

describe('decideSuspendAccount', () => {
  it('logs the suspension of an account that is not suspended, by the administrator, as its subject', () => {
    const decision = decideSuspendAccount(active(), admin, at);
    expect(decision.isSuccess()).toBe(true);
    expect(decision.data!.state!.toSnapshot()).toMatchObject({ by: 'root', action: 'suspended', subjectId: id, at });
  });

  it('changes nothing, and logs nothing, for an account suspended already', () => {
    expect(decideSuspendAccount(suspended(), admin, at).data!.state).toBeUndefined();
  });

  it('refuses a caller who is not an administrator, and an account that is not there', () => {
    const notAdmin = decideSuspendAccount(active(), { by: 'ada', administrator: false }, at);
    expect(notAdmin.isFailure() && notAdmin.error.type).toBe('NotAllowed');
    const missing = decideSuspendAccount(undefined, admin, at);
    expect(missing.isFailure() && missing.error.type).toBe('NotFound');
  });
});

describe('decideReinstateAccount', () => {
  it('logs the reinstatement of a suspended account', () => {
    const decision = decideReinstateAccount(suspended(), admin, at);
    expect(decision.data!.state!.toSnapshot()).toMatchObject({ by: 'root', action: 'reinstated', subjectId: id });
  });

  it('changes nothing for an account that is not suspended, and refuses anyone but an administrator', () => {
    expect(decideReinstateAccount(active(), admin, at).data!.state).toBeUndefined();
    const notAdmin = decideReinstateAccount(suspended(), { by: 'ada', administrator: false }, at);
    expect(notAdmin.isFailure() && notAdmin.error.type).toBe('NotAllowed');
  });
});
