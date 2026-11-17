import { Application } from './app';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;
const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const at = (days: number) => new Date(T0 + days * DAY);

describe('reminders', () => {
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

  /** Ada pays an expense split with Grace, so that Grace owes half of it. */
  async function adaPays(amount: number): Promise<string> {
    const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: { description: 'Rent', amount, date: '2026-11-01', splitBetween: [adaId, graceId] },
      token: adaToken,
    });
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  async function reminders(token = graceToken) {
    const answer = await call(app, 'GET', '/notices', { token });
    return (answer.body as Array<{ kind: string }>).filter(n => n.kind === 'reminder');
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    app = await startApplication(database.path);
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: graceToken });
  });

  afterEach(async () => {
    await app.stop();
    database.remove();
  });

  it('reminds a member who has owed more than 2000 for a week, and again each week', async () => {
    await adaPays(4002); // Grace owes 2001
    app.runJobs(at(0));
    app.runJobs(at(6));
    expect(await reminders()).toEqual([]);

    app.runJobs(at(7));
    expect(await reminders()).toEqual([
      { id: expect.any(String), kind: 'reminder', groupId, amount: 2001, at: at(7).toISOString() },
    ]);
    expect(Object.keys((await reminders())[0])).not.toContain('expenseId');

    app.runJobs(at(8));
    app.runJobs(at(13));
    expect(await reminders()).toHaveLength(1);
    app.runJobs(at(14));
    expect(await reminders()).toHaveLength(2);
    expect(await reminders(adaToken)).toEqual([]);
  });

  it('does not remind a debt of 2000 or less', async () => {
    await adaPays(4000); // 2000
    app.runJobs(at(0));
    app.runJobs(at(30));
    expect(await reminders()).toEqual([]);
  });

  it('notes a debt from the run that sees it, not from when it began', async () => {
    await adaPays(5000);
    app.runJobs(at(5));
    app.runJobs(at(7));
    expect(await reminders()).toEqual([]);
    app.runJobs(at(12));
    expect(await reminders()).toHaveLength(1);
  });

  it('notes a debt that lapsed and came back from the run that sees it again', async () => {
    await adaPays(5000);
    app.runJobs(at(0));
    const settle = await call(app, 'POST', `/groups/${groupId}/settlements/cash`, {
      body: { from: graceId, amount: 2500 },
      token: adaToken,
    });
    expect(settle.status).toBe(201);
    app.runJobs(at(5)); // owes nothing: no longer noted
    await adaPays(5000);
    app.runJobs(at(6)); // noted again
    app.runJobs(at(7));
    expect(await reminders()).toEqual([]);
    app.runJobs(at(13));
    expect(await reminders()).toHaveLength(1);
  });

  it('does not remind a member who has left, nor change anything on a read', async () => {
    await adaPays(5000);
    app.runJobs(at(0));
    await call(app, 'GET', '/notices', { token: graceToken });
    await call(app, 'GET', `/groups/${groupId}/balances`, { token: adaToken });
    expect(await reminders()).toEqual([]);
    // Reading a week later notes and reminds nothing: only a run does.
    const late = await call(app, 'GET', '/notices', { token: graceToken });
    expect(late.body).toEqual([expect.objectContaining({ kind: 'expense' })]);
  });

  it('reminds once a week however many servers share the database', async () => {
    const other = await startApplication(database.path);
    try {
      await adaPays(5000);
      app.runJobs(at(0));
      other.runJobs(at(0));
      app.runJobs(at(7));
      other.runJobs(at(7));
      other.runJobs(at(7.5));
      expect(await reminders()).toHaveLength(1);
      expect((await reminders())[0]).toMatchObject({ at: expect.stringMatching(AT_PATTERN) });
    } finally {
      await other.stop();
    }
  });

  it('runs by itself every JOBS_INTERVAL_SECONDS, with the period from REMINDER_PERIOD_SECONDS', async () => {
    const fast = await (async () => {
      const { createApplication } = await import('./app');
      const a = await createApplication({
        databasePath: database.path,
        providerUrl: '',
        providerWebhookSecret: '',
        jobsIntervalSeconds: 0.05,
        reminderPeriodSeconds: 0.2,
      });
      await a.start(0);
      return a;
    })();
    try {
      await adaPays(5000);
      const deadline = Date.now() + 5000;
      while ((await reminders()).length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      expect((await reminders()).length).toBeGreaterThanOrEqual(2);
    } finally {
      await fast.stop();
    }
  });
});
