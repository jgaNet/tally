import { createApplication, type Application } from './app';
import { send, signedUpAccount, testDirectory, type TestDirectory } from './test-helpers';

const START = Date.parse('2026-11-10T09:00:00.000Z');

describe('recurring expenses', () => {
  let directory: TestDirectory;
  let app: Application;
  let now: number;

  async function startAt(): Promise<Application> {
    const started = await createApplication({ databasePath: directory.databasePath, clock: () => new Date(now) });
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
    directory.remove();
  });

  async function group() {
    const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
    const cy = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
    const created = await send(app, 'POST', '/groups', { token: bob.token, body: { name: 'Flat', currency: 'EUR' } });
    const groupId = (created.body as { id: string }).id;
    const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: bob.token });
    await send(app, 'POST', `/invitations/${(invitation.body as { id: string }).id}/accept`, { token: cy.token });
    return { bob, cy, groupId };
  }

  const rent = (bob: { id: string }, cy: { id: string }, startsOn: string, extra = {}) => ({
    description: 'Rent',
    amount: 1001,
    startsOn,
    splitBetween: [bob.id, cy.id],
    ...extra,
  });

  async function expensesOf(token: string, groupId: string) {
    const reply = await send(app, 'GET', `/groups/${groupId}/expenses`, { token });
    return reply.body as { id: string; date: string; paidBy: string; amount: number; description: string }[];
  }

  it('sets up a recurring expense and reads it, the split as given', async () => {
    const { bob, cy, groupId } = await group();
    const body = rent(bob, cy, '2026-09-05');
    const created = await send(app, 'POST', `/groups/${groupId}/recurring`, { token: bob.token, body });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    const read = await send(app, 'GET', `/recurring/${id}`, { token: cy.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id,
      groupId,
      paidBy: bob.id,
      description: 'Rent',
      amount: 1001,
      startsOn: '2026-09-05',
      next: '2026-09-05',
      category: 'other',
      splitBetween: [bob.id, cy.id],
    });
    const exact = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: cy.token,
      body: {
        description: 'Net',
        amount: 30,
        startsOn: '2026-12-01',
        splitExactly: [
          { memberId: bob.id, amount: 10 },
          { memberId: cy.id, amount: 20 },
        ],
      },
    });
    const shares = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: cy.token,
      body: {
        description: 'Gas',
        amount: 30,
        startsOn: '2026-12-02',
        splitByShares: [
          { memberId: bob.id, shares: 1 },
          { memberId: cy.id, shares: 2 },
        ],
      },
    });
    const list = await send(app, 'GET', `/groups/${groupId}/recurring`, { token: bob.token });
    expect((list.body as { description: string }[]).map(r => r.description)).toEqual(['Rent', 'Net', 'Gas']);
    expect(list.body).toEqual([
      read.body,
      expect.objectContaining({
        id: (exact.body as { id: string }).id,
        splitExactly: [
          { memberId: bob.id, amount: 10 },
          { memberId: cy.id, amount: 20 },
        ],
      }),
      expect.objectContaining({
        id: (shares.body as { id: string }).id,
        splitByShares: [
          { memberId: bob.id, shares: 1 },
          { memberId: cy.id, shares: 2 },
        ],
      }),
    ]);
  });

  it('refuses what an expense or a start day would refuse', async () => {
    const { bob, cy, groupId } = await group();
    const outsider = await signedUpAccount(app, { email: 'out@example.com' });
    const post = (body: unknown, token = bob.token) =>
      send(app, 'POST', `/groups/${groupId}/recurring`, { token, body });
    expect((await post(rent(bob, cy, '2026-11-29'))).status).toBe(422);
    expect((await post(rent(bob, cy, '2026-11-31'))).status).toBe(422);
    expect((await post(rent(bob, cy, 'soon'))).status).toBe(422);
    expect((await post(rent(bob, cy, '2025-11-09'))).status).toBe(422);
    expect((await post(rent(bob, cy, '2027-11-11'))).status).toBe(422);
    expect((await post(rent(bob, cy, '2025-11-10'))).status).toBe(201);
    expect((await post(rent(bob, cy, '2027-11-10'))).status).toBe(201);
    expect((await post(rent(bob, cy, '2026-11-05', { amount: 0 }))).status).toBe(422);
    expect((await post(rent(bob, cy, '2026-11-05', { description: '  ' }))).status).toBe(422);
    expect((await post(rent(bob, cy, '2026-11-05', { splitBetween: [cy.id] }))).status).toBe(422);
    expect((await post(rent(bob, cy, '2026-11-05', { splitBetween: [bob.id, bob.id] }))).status).toBe(422);
    expect((await post(rent(bob, cy, '2026-11-05', { splitBetween: [bob.id, outsider.id] }))).status).toBe(422);
    expect((await post(rent(bob, cy, '2026-11-05', { splitExactly: [{ memberId: bob.id, amount: 1 }] }))).status).toBe(
      400,
    );
    expect((await post(rent(bob, cy, '2026-11-05'), outsider.token)).status).toBe(404);
    expect(
      (await send(app, 'POST', `/groups/${groupId}/recurring`, { body: rent(bob, cy, '2026-11-05') })).status,
    ).toBe(401);
  });

  it('records the expenses already passed at the next run, never at a read, and each day once', async () => {
    const { bob, cy, groupId } = await group();
    const created = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: bob.token,
      body: rent(bob, cy, '2026-09-05'),
    });
    const id = (created.body as { id: string }).id;
    await send(app, 'GET', `/recurring/${id}`, { token: bob.token });
    expect(await expensesOf(bob.token, groupId)).toEqual([]);

    app.runJobs();
    app.runJobs();
    const expenses = await expensesOf(bob.token, groupId);
    expect(expenses.map(e => e.date)).toEqual(['2026-11-05', '2026-10-05', '2026-09-05']);
    expect(expenses[0]).toMatchObject({
      paidBy: bob.id,
      amount: 1001,
      description: 'Rent',
      shares: [
        { memberId: bob.id, amount: 501 },
        { memberId: cy.id, amount: 500 },
      ],
    });
    const read = await send(app, 'GET', `/recurring/${id}`, { token: bob.token });
    expect(read.body).toMatchObject({ next: '2026-12-05' });

    // A second server on the same file does not record them again.
    const other = await createApplication({ databasePath: directory.databasePath, clock: () => new Date(now) });
    other.runJobs();
    await other.stop();
    expect(await expensesOf(bob.token, groupId)).toHaveLength(3);

    now = Date.parse('2026-12-04T23:59:00.000Z');
    app.runJobs();
    expect(await expensesOf(bob.token, groupId)).toHaveLength(3);
    now = Date.parse('2026-12-05T00:00:00.000Z');
    app.runJobs();
    expect((await expensesOf(bob.token, groupId))[0]?.date).toBe('2026-12-05');
    now = Date.parse('2027-02-20T00:00:00.000Z');
    app.runJobs();
    expect((await expensesOf(bob.token, groupId)).map(e => e.date).slice(0, 3)).toEqual([
      '2027-02-05',
      '2027-01-05',
      '2026-12-05',
    ]);
  });

  it('records expenses like any other: balances, notices, edit and delete, and a deleted one is not recorded again', async () => {
    const { bob, cy, groupId } = await group();
    await send(app, 'POST', `/groups/${groupId}/recurring`, { token: bob.token, body: rent(bob, cy, '2026-11-05') });
    app.runJobs();
    const balances = await send(app, 'GET', `/groups/${groupId}/balances`, { token: bob.token });
    expect(balances.body).toEqual([
      { memberId: bob.id, balance: 500 },
      { memberId: cy.id, balance: -500 },
    ]);
    const notices = await send(app, 'GET', '/notices', { token: cy.token });
    expect(notices.body).toEqual([expect.objectContaining({ kind: 'expense', groupId, amount: 500 })]);
    const [expense] = await expensesOf(bob.token, groupId);
    expect((await send(app, 'DELETE', `/expenses/${expense?.id}`, { token: bob.token })).status).toBe(204);
    app.runJobs();
    expect(await expensesOf(bob.token, groupId)).toEqual([]);
  });

  it('stops: its payer or the owner stops it, nobody else, and its expenses stay', async () => {
    const { bob, cy, groupId } = await group();
    const dan = await signedUpAccount(app, { email: 'dan@example.com' });
    const made = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: cy.token,
      body: rent(bob, cy, '2026-11-05'),
    });
    const id = (made.body as { id: string }).id;
    app.runJobs();
    expect((await send(app, 'DELETE', `/recurring/${id}`, { token: dan.token })).status).toBe(404);
    const other = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: cy.token,
      body: rent(bob, cy, '2026-12-05'),
    });
    expect((await send(app, 'DELETE', `/recurring/${id}`, { token: bob.token })).status).toBe(204); // the owner
    expect((await send(app, 'GET', `/recurring/${id}`, { token: bob.token })).status).toBe(404);
    expect(
      (await send(app, 'DELETE', `/recurring/${(other.body as { id: string }).id}`, { token: cy.token })).status,
    ).toBe(204); // the payer
    now = Date.parse('2026-12-20T00:00:00.000Z');
    app.runJobs();
    expect(await expensesOf(bob.token, groupId)).toHaveLength(1);
    expect((await send(app, 'GET', `/groups/${groupId}/recurring`, { token: bob.token })).body).toEqual([]);
  });

  it('ends when its payer or a member of its split has left', async () => {
    const { bob, cy, groupId } = await group();
    const made = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: bob.token,
      body: rent(bob, cy, '2026-11-05'),
    });
    const id = (made.body as { id: string }).id;
    app.runJobs();
    await send(app, 'POST', `/groups/${groupId}/leave`, { token: cy.token });
    now = Date.parse('2026-12-06T00:00:00.000Z');
    app.runJobs();
    expect(await expensesOf(bob.token, groupId)).toHaveLength(1);
    expect((await send(app, 'GET', `/recurring/${id}`, { token: bob.token })).status).toBe(404);
  });
});
