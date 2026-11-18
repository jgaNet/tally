import { Application } from './app';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const DAY = 24 * 3600 * 1000;

/** The day `days` from today, in UTC. */
const dayFromToday = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
/** A day of 1 to 28 of the month `months` before this one, with the day of month `dom`. */
function monthsAgo(months: number, dom: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, dom));
  return d.toISOString().slice(0, 10);
}

describe('recurring expenses', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let groupId: string;

  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  async function setUp(startsOn: string, extra: object = {}, token = adaToken) {
    return call(app, 'POST', `/groups/${groupId}/recurring`, {
      body: { description: 'Rent', amount: 1001, startsOn, splitBetween: [adaId, graceId], ...extra },
      token,
    });
  }

  async function expenses(): Promise<Array<{ date: string; paidBy: string; amount: number; shares: unknown[] }>> {
    return (await call(app, 'GET', `/groups/${groupId}/expenses`, { token: adaToken })).body;
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    app = await startApplication(database.url);
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: graceToken });
  });

  afterEach(async () => {
    await app.stop();
    await database.remove();
  });

  it('sets up a recurring expense and reads it as it was given', async () => {
    const startsOn = monthsAgo(-1, 5);
    const created = await setUp(startsOn);
    expect(created.status).toBe(201);
    const read = await call(app, 'GET', `/recurring/${created.body.id}`, { token: graceToken });
    expect(read).toEqual({
      status: 200,
      body: {
        id: created.body.id,
        groupId,
        paidBy: adaId,
        description: 'Rent',
        amount: 1001,
        startsOn,
        next: startsOn,
        category: 'other',
        splitBetween: [adaId, graceId],
      },
    });
  });

  it('reads the split by amounts and by shares as given', async () => {
    const startsOn = monthsAgo(-1, 5);
    const exact = await setUp(startsOn, {
      splitBetween: undefined,
      splitExactly: [
        { memberId: graceId, amount: 1 },
        { memberId: adaId, amount: 1000 },
      ],
    });
    const shares = await setUp(startsOn, {
      splitBetween: undefined,
      splitByShares: [
        { memberId: adaId, shares: 2 },
        { memberId: graceId, shares: 1 },
      ],
    });
    expect((await call(app, 'GET', `/recurring/${exact.body.id}`, { token: adaToken })).body.splitExactly).toEqual([
      { memberId: graceId, amount: 1 },
      { memberId: adaId, amount: 1000 },
    ]);
    const read = (await call(app, 'GET', `/recurring/${shares.body.id}`, { token: adaToken })).body;
    expect(read.splitByShares).toEqual([
      { memberId: adaId, shares: 2 },
      { memberId: graceId, shares: 1 },
    ]);
    expect(read.splitBetween).toBeUndefined();
  });

  it('lists the group recurring expenses, the earliest set up first, to members only', async () => {
    const first = await setUp(monthsAgo(-1, 9));
    const second = await setUp(monthsAgo(-1, 3), { description: 'Internet' });
    const list = await call(app, 'GET', `/groups/${groupId}/recurring`, { token: graceToken });
    expect(list.body.map((r: { id: string }) => r.id)).toEqual([first.body.id, second.body.id]);
    const outsider = await accountOf({ email: 'x@example.com', password: 'password-123', name: 'Outsider' });
    expect((await call(app, 'GET', `/groups/${groupId}/recurring`, { token: outsider.token })).status).toBe(404);
    expect((await call(app, 'GET', `/recurring/${first.body.id}`, { token: outsider.token })).status).toBe(404);
  });

  it('refuses what an expense or a first day would not accept', async () => {
    const ok = monthsAgo(-1, 5);
    const refused = async (extra: object) => (await setUp(ok, extra)).status;
    expect(await refused({ description: '  ' })).toBe(422);
    expect(await refused({ amount: 0 })).toBe(422);
    expect(await refused({ splitBetween: [adaId] })).toBe(201); // alone is fine
    expect(await refused({ splitBetween: [graceId] })).toBe(422); // payer missing
    expect(await refused({ splitBetween: [adaId, adaId] })).toBe(422);
    expect(await refused({ splitBetween: [adaId, 'nobody'] })).toBe(422);
    expect(await refused({ splitExactly: [{ memberId: adaId, amount: 5 }] })).toBe(400); // two splits
    expect(await refused({ splitBetween: undefined })).toBe(400); // no split
    expect(await refused({ splitBetween: undefined, splitExactly: [{ memberId: adaId, amount: 5 }] })).toBe(422);
    expect((await setUp(ok, { startsOn: '2026-02-30' })).status).toBe(422);
    expect((await setUp(ok, { startsOn: 'tomorrow' })).status).toBe(422);
    const d29 = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 29));
    expect((await setUp(ok, { startsOn: d29.toISOString().slice(0, 10) })).status).toBe(422);
    expect((await setUp(ok, { startsOn: dayFromToday(400) })).status).toBe(422);
    expect((await setUp(ok, { startsOn: dayFromToday(-400) })).status).toBe(422);
    expect((await call(app, 'POST', `/groups/nope/recurring`, { body: {}, token: adaToken })).status).toBe(400);
  });

  it('records the expenses of every day already passed at the next run, and the next on its day', async () => {
    const startsOn = monthsAgo(2, 5);
    const created = await setUp(startsOn);
    expect(await expenses()).toEqual([]); // a read records nothing
    const now = new Date();
    await app.runJobs(now);
    const today = now.toISOString().slice(0, 10);
    const due = [monthsAgo(2, 5), monthsAgo(1, 5), monthsAgo(0, 5)].filter(day => day <= today);
    const recorded = await expenses();
    expect(recorded.map(e => e.date).sort()).toEqual(due);
    expect(recorded.every(e => e.paidBy === adaId && e.amount === 1001)).toBe(true);
    const read = (await call(app, 'GET', `/recurring/${created.body.id}`, { token: adaToken })).body;
    expect(read.next > today).toBe(true);
    expect(read.next.slice(8)).toBe('05');
    expect(read.startsOn).toBe(startsOn);
    // running again records nothing more, and the next day's run records it once
    await app.runJobs(now);
    expect(await expenses()).toHaveLength(due.length);
    await app.runJobs(new Date(Date.parse(`${read.next}T00:00:00Z`) + 1000));
    expect(await expenses()).toHaveLength(due.length + 1);
  });

  it('records nothing before its day', async () => {
    await setUp(monthsAgo(-1, 5));
    await app.runJobs();
    expect(await expenses()).toEqual([]);
  });

  it('makes expenses like any other: balances, notices, edits and deletes by the payer or owner', async () => {
    await setUp(monthsAgo(1, 5), { amount: 1001 });
    await app.runJobs(new Date(Date.parse(`${monthsAgo(1, 5)}T08:00:00Z`)));
    const [expense] = await expenses();
    expect(expense.shares).toEqual([
      { memberId: adaId, amount: 501 },
      { memberId: graceId, amount: 500 },
    ]);
    const balances = (await call(app, 'GET', `/groups/${groupId}/balances`, { token: graceToken })).body;
    expect(balances).toEqual([
      { memberId: adaId, balance: 500 },
      { memberId: graceId, balance: -500 },
    ]);
    const notices = (await call(app, 'GET', '/notices', { token: graceToken })).body;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'expense', groupId, amount: 500 });
    expect((await call(app, 'GET', '/notices', { token: adaToken })).body).toEqual([]);
    const id = (await call(app, 'GET', `/groups/${groupId}/expenses`, { token: adaToken })).body[0].id;
    expect((await call(app, 'DELETE', `/expenses/${id}`, { token: graceToken })).status).toBe(403);
    expect((await call(app, 'DELETE', `/expenses/${id}`, { token: adaToken })).status).toBe(204);
  });

  it('is stopped by its payer or the owner only, and keeps the expenses it recorded', async () => {
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    const hopper = await accountOf({ email: 'h@example.com', password: 'password-123', name: 'Third' });
    await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: hopper.token });
    const byGrace = await setUp(monthsAgo(1, 5), { splitBetween: [graceId] }, graceToken);
    expect((await call(app, 'DELETE', `/recurring/${byGrace.body.id}`, { token: hopper.token })).status).toBe(403);
    await app.runJobs(new Date(Date.parse(`${monthsAgo(1, 5)}T08:00:00Z`)));
    expect(await expenses()).toHaveLength(1);
    expect((await call(app, 'DELETE', `/recurring/${byGrace.body.id}`, { token: adaToken })).status).toBe(204);
    expect((await call(app, 'GET', `/recurring/${byGrace.body.id}`, { token: adaToken })).status).toBe(404);
    expect((await call(app, 'DELETE', `/recurring/${byGrace.body.id}`, { token: adaToken })).status).toBe(404);
    await app.runJobs();
    expect(await expenses()).toHaveLength(1);
    const own = await setUp(monthsAgo(-1, 5));
    expect((await call(app, 'DELETE', `/recurring/${own.body.id}`, { token: adaToken })).status).toBe(204);
    expect((await call(app, 'GET', `/groups/${groupId}/recurring`, { token: adaToken })).body).toEqual([]);
  });

  it('ends when its payer or a member of its split has left, recording nothing', async () => {
    const byAda = await setUp(monthsAgo(1, 5));
    const byGrace = await setUp(monthsAgo(1, 5), { splitBetween: [graceId] }, graceToken);
    await call(app, 'POST', `/groups/${groupId}/leave`, { token: graceToken });
    await app.runJobs();
    expect(await expenses()).toEqual([]);
    expect((await call(app, 'GET', `/recurring/${byAda.body.id}`, { token: adaToken })).status).toBe(404);
    expect((await call(app, 'GET', `/groups/${groupId}/recurring`, { token: adaToken })).body).toEqual([]);
    expect(byGrace.status).toBe(201);
  });

  it('records each day once however many servers run on the database, and across restarts', async () => {
    await setUp(monthsAgo(2, 5));
    const other = await startApplication(database.url);
    try {
      const now = new Date();
      await app.runJobs(now);
      await other.runJobs(now);
      const count = (await expenses()).length;
      expect(count).toBeGreaterThanOrEqual(2);
      await app.stop();
      app = await startApplication(database.url);
      const again = (await call(app, 'POST', '/accounts/login', { body: ada })).body.token;
      adaToken = again;
      await app.runJobs(now);
      expect(await expenses()).toHaveLength(count);
    } finally {
      await other.stop();
    }
  });
});
