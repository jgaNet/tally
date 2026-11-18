import { createApplication, type Application } from './app';
import { ensureDatabase, send, signedUpAccount, testDirectory, type TestDirectory } from './test-helpers';

const START = Date.parse('2026-11-02T09:00:00.000Z');

interface Member {
  id: string;
  token: string;
}

/** The notices of the account of `token`, of one kind, as the API answers them. */
async function noticesOfKind(app: Application, token: string, kind: string): Promise<Record<string, unknown>[]> {
  const reply = await send(app, 'GET', '/notices', { token });
  expect(reply.status).toBe(200);
  return (reply.body as Record<string, unknown>[]).filter(notice => notice.kind === kind);
}

describe('notice preferences', () => {
  let directory: TestDirectory;
  let app: Application;
  /** The time the application's clock tells; moved by the tests. */
  let now: number;

  async function startAt(): Promise<Application> {
    await ensureDatabase(directory.databaseUrl);
    const started = await createApplication({
      databaseUrl: directory.databaseUrl,
      clock: () => new Date(now),
    });
    await started.start(0);
    return started;
  }

  beforeEach(async () => {
    now = START;
    directory = testDirectory();
    app = await startAt();
  });

  afterEach(async () => {
    await app.stop();
    await directory.remove();
  });

  /** Bob's group, which Cy and Dee joined: Bob is its owner. */
  async function household(): Promise<{ bob: Member; cy: Member; dee: Member; groupId: string }> {
    const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
    const cy = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
    const dee = await signedUpAccount(app, { email: 'dee@example.com', name: 'Dee' });
    const created = await send(app, 'POST', '/groups', { token: bob.token, body: { name: 'Flat', currency: 'EUR' } });
    const groupId = (created.body as { id: string }).id;
    for (const member of [cy, dee]) {
      const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: bob.token });
      const accepted = await send(app, 'POST', `/invitations/${(invitation.body as { id: string }).id}/accept`, {
        token: member.token,
      });
      if (accepted.status !== 204) throw new Error(`accept answered ${accepted.status}`);
    }
    return { bob, cy, dee, groupId };
  }

  async function recordOk(token: string, groupId: string, body: Record<string, unknown>): Promise<string> {
    const reply = await send(app, 'POST', `/groups/${groupId}/expenses`, { token, body });
    if (reply.status !== 201) throw new Error(`expense answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  async function setPreference(token: string, kind: string, enabled: boolean) {
    return send(app, 'PUT', `/accounts/me/notice-preferences/${kind}`, { token, body: { enabled } });
  }

  async function preferencesOf(token: string) {
    return send(app, 'GET', '/accounts/me/notice-preferences', { token });
  }

  it('reads every kind on, in the order expense, reminder, budget, until its person turns it off', async () => {
    const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
    expect(await preferencesOf(bob.token)).toEqual({
      status: 200,
      body: [
        { kind: 'expense', enabled: true },
        { kind: 'reminder', enabled: true },
        { kind: 'budget', enabled: true },
      ],
    });
  });

  it('turns a kind off and on again for the caller, and changes no other kind', async () => {
    const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
    expect(await setPreference(bob.token, 'reminder', false)).toMatchObject({ status: 204 });
    expect((await preferencesOf(bob.token)).body).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: false },
      { kind: 'budget', enabled: true },
    ]);

    expect(await setPreference(bob.token, 'reminder', true)).toMatchObject({ status: 204 });
    expect(await setPreference(bob.token, 'reminder', true)).toMatchObject({ status: 204 });
    expect((await preferencesOf(bob.token)).body).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: true },
      { kind: 'budget', enabled: true },
    ]);
  });

  it('refuses a kind that is not one of the kinds, a body without a boolean enabled, and a caller not signed in', async () => {
    const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
    expect(await setPreference(bob.token, 'tips', false)).toMatchObject({
      status: 422,
      body: { error: 'NoticeKindIsUnsupported' },
    });
    for (const body of [{ enabled: 'no' }, { enabled: 0 }, {}]) {
      expect(
        await send(app, 'PUT', '/accounts/me/notice-preferences/expense', { token: bob.token, body }),
      ).toMatchObject({ status: 400 });
    }
    expect(await send(app, 'GET', '/accounts/me/notice-preferences')).toMatchObject({ status: 401 });
    expect(
      await send(app, 'PUT', '/accounts/me/notice-preferences/expense', { body: { enabled: false } }),
    ).toMatchObject({ status: 401 });
    // Nothing was turned off by the refused changes.
    expect((await preferencesOf(bob.token)).body).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: true },
      { kind: 'budget', enabled: true },
    ]);
  });

  it('turns off the caller alone: the others of the group keep theirs', async () => {
    const { bob, cy, dee, groupId } = await household();
    expect(await setPreference(cy.token, 'expense', false)).toMatchObject({ status: 204 });

    expect((await preferencesOf(bob.token)).body).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: true },
      { kind: 'budget', enabled: true },
    ]);
    await recordOk(bob.token, groupId, {
      description: 'Shop',
      amount: 900,
      date: '2026-11-02',
      splitBetween: [bob.id, cy.id, dee.id],
    });
    expect(await noticesOfKind(app, dee.token, 'expense')).toHaveLength(1);
    expect(await noticesOfKind(app, cy.token, 'expense')).toEqual([]);
  });

  it('makes no expense notice to a member who turned them off, from then on, and changes none made before', async () => {
    const { bob, cy, dee, groupId } = await household();
    const members = [bob.id, cy.id, dee.id];

    const first = await recordOk(bob.token, groupId, {
      description: 'Pizzas',
      amount: 900,
      date: '2026-11-02',
      splitBetween: members,
    });
    expect(await setPreference(cy.token, 'expense', false)).toMatchObject({ status: 204 });
    const second = await recordOk(bob.token, groupId, {
      description: 'Wine',
      amount: 1200,
      date: '2026-11-02',
      splitBetween: members,
    });

    // Cy was told of the first expense, made before they turned notices off; nothing of the second is made for them.
    expect(await noticesOfKind(app, cy.token, 'expense')).toEqual([
      expect.objectContaining({ kind: 'expense', expenseId: first, amount: 300 }),
    ]);
    expect(await noticesOfKind(app, dee.token, 'expense')).toEqual([
      expect.objectContaining({ expenseId: second, amount: 400 }),
      expect.objectContaining({ expenseId: first, amount: 300 }),
    ]);

    // Turned on again: the expenses recorded from then on are noticed, and nothing missed is made later.
    expect(await setPreference(cy.token, 'expense', true)).toMatchObject({ status: 204 });
    expect(await noticesOfKind(app, cy.token, 'expense')).toHaveLength(1);
    const third = await recordOk(bob.token, groupId, {
      description: 'Cake',
      amount: 600,
      date: '2026-11-02',
      splitBetween: members,
    });
    expect(await noticesOfKind(app, cy.token, 'expense')).toEqual([
      expect.objectContaining({ expenseId: third, amount: 200 }),
      expect.objectContaining({ expenseId: first, amount: 300 }),
    ]);
  });

  it('makes no budget notice to a member who turned them off; the others are told once, and nothing missed is made later', async () => {
    const { bob, cy, dee, groupId } = await household();
    const members = [bob.id, cy.id, dee.id];
    expect(
      await send(app, 'PUT', `/groups/${groupId}/budgets/groceries`, { token: bob.token, body: { amount: 1000 } }),
    ).toMatchObject({ status: 204 });
    expect(await setPreference(cy.token, 'budget', false)).toMatchObject({ status: 204 });

    await recordOk(bob.token, groupId, {
      description: 'Shop',
      amount: 1500,
      date: '2026-11-02',
      category: 'groceries',
      splitBetween: members,
    });
    // Bob and Dee are told once each, the payer too; Cy, who turned them off, is told nothing.
    expect(await noticesOfKind(app, bob.token, 'budget')).toMatchObject([{ category: 'groceries', amount: 1500 }]);
    expect(await noticesOfKind(app, dee.token, 'budget')).toMatchObject([{ category: 'groceries', amount: 1500 }]);
    expect(await noticesOfKind(app, cy.token, 'budget')).toEqual([]);

    // Turned on again in the same month: nothing missed is made, and the month is not told again.
    expect(await setPreference(cy.token, 'budget', true)).toMatchObject({ status: 204 });
    await recordOk(bob.token, groupId, {
      description: 'More shopping',
      amount: 500,
      date: '2026-11-03',
      category: 'groceries',
      splitBetween: members,
    });
    expect(await noticesOfKind(app, cy.token, 'budget')).toEqual([]);
    expect(await noticesOfKind(app, bob.token, 'budget')).toHaveLength(1);
    expect(await noticesOfKind(app, dee.token, 'budget')).toHaveLength(1);
  });
});
