import { Application } from './app';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2026-11-01T10:00:00.000Z');
const at = (days: number) => new Date(T0 + days * DAY);
const today = (): string => new Date().toISOString().slice(0, 10);
const thisMonth = (): string => today().slice(0, 7);

/** The last day of the month before this one, in UTC: a day already past whatever day it is now. */
function lastDayOfLastMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

const ALL_ON = [
  { kind: 'expense', enabled: true },
  { kind: 'reminder', enabled: true },
  { kind: 'budget', enabled: true },
];

describe('notice preferences', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;
  let groupId: string;

  /** Signs the account up and in, and answers its id and token. */
  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  /** Brings the account into the group by an invitation of the owner. */
  async function join(accountToken: string): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    const answer = await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken });
    expect(answer.status).toBe(204);
  }

  async function setPreference(kind: string, enabled: boolean, token: string) {
    return call(app, 'PUT', `/accounts/me/notice-preferences/${kind}`, { body: { enabled }, token });
  }

  async function preferencesOf(token: string) {
    const answer = await call(app, 'GET', '/accounts/me/notice-preferences', { token });
    expect(answer.status).toBe(200);
    return answer.body;
  }

  /** The notices of the account, as the API answers them. */
  async function noticesOf(token: string): Promise<Array<{ kind: string; expenseId?: string; amount: number }>> {
    const answer = await call(app, 'GET', '/notices', { token });
    expect(answer.status).toBe(200);
    return answer.body;
  }

  /** Records an expense of the group by the token's account, split between the three members. */
  async function record(fields: Record<string, unknown> = {}, token = adaToken): Promise<string> {
    const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: {
        description: 'Shop',
        amount: 3000,
        date: today(),
        splitBetween: [adaId, graceId, linusId],
        ...fields,
      },
      token,
    });
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  async function setBudget(category: string, amount: number): Promise<void> {
    const answer = await call(app, 'PUT', `/groups/${groupId}/budgets/${category}`, {
      body: { amount },
      token: adaToken,
    });
    expect(answer.status).toBe(204);
  }

  /** Runs the background job at `days` after the start, as the server would. */
  async function runAt(days: number): Promise<void> {
    await app.runJobs(at(days));
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    app = await startApplication(database.url);
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    await join(graceToken);
    await join(linusToken);
  });

  afterEach(async () => {
    await app.stop();
    await database.remove();
  });

  it('lists every kind as on, in the order expense, reminder, budget, to one who has changed nothing', async () => {
    expect(await preferencesOf(graceToken)).toEqual(ALL_ON);
  });

  it('turns a kind off and on again, and lists it so, the others as they are', async () => {
    expect((await setPreference('reminder', false, graceToken)).status).toBe(204);
    expect(await preferencesOf(graceToken)).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: false },
      { kind: 'budget', enabled: true },
    ]);

    expect((await setPreference('budget', false, graceToken)).status).toBe(204);
    expect((await setPreference('reminder', true, graceToken)).status).toBe(204);
    expect(await preferencesOf(graceToken)).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: true },
      { kind: 'budget', enabled: false },
    ]);
  });

  it('answers the same preferences on every read, and a read changes none', async () => {
    await setPreference('expense', false, graceToken);
    const first = await preferencesOf(graceToken);
    expect(await preferencesOf(graceToken)).toEqual(first);
    expect(first[0]).toEqual({ kind: 'expense', enabled: false });
  });

  it('keeps the preferences when the server is stopped and started again', async () => {
    await setPreference('budget', false, graceToken);
    await app.stop();
    app = await startApplication(database.url);

    expect((await preferencesOf(graceToken))[2]).toEqual({ kind: 'budget', enabled: false });
  });

  it('lists to each person only their own preferences', async () => {
    await setPreference('expense', false, graceToken);

    expect(await preferencesOf(linusToken)).toEqual(ALL_ON);
    expect(await preferencesOf(adaToken)).toEqual(ALL_ON);
    expect((await preferencesOf(graceToken))[0]).toEqual({ kind: 'expense', enabled: false });
  });

  describe('expense notices', () => {
    it('makes no expense notice for a member who has turned them off, the others still get theirs', async () => {
      await setPreference('expense', false, graceToken);
      await record();

      expect(await noticesOf(graceToken)).toEqual([]);
      expect(await noticesOf(linusToken)).toHaveLength(1);
      expect(await noticesOf(linusToken)).toMatchObject([{ kind: 'expense', amount: 1000 }]);
    });

    it('leaves the notices made before the change as they were', async () => {
      await record();
      await setPreference('expense', false, graceToken);

      expect(await noticesOf(graceToken)).toMatchObject([{ kind: 'expense', amount: 1000 }]);
    });

    it('makes the notices of a kind turned on again from then on, and never the ones missed while off', async () => {
      await setPreference('expense', false, graceToken);
      await record({ amount: 3000 });
      await setPreference('expense', true, graceToken);
      await record({ amount: 6000 });

      const graceNotices = await noticesOf(graceToken);
      expect(graceNotices).toEqual([expect.objectContaining({ kind: 'expense', amount: 2000 })]);
      expect(await noticesOf(linusToken)).toHaveLength(2);
    });
  });

  describe('budget notices', () => {
    it('tells the others of a passing once, and not the member who has turned budget notices off', async () => {
      await setBudget('groceries', 4000);
      await setPreference('budget', false, graceToken);
      await record({ category: 'groceries', amount: 3000 });
      await record({ category: 'groceries', amount: 2000 });

      expect((await noticesOf(graceToken)).filter(n => n.kind === 'budget')).toEqual([]);
      expect((await noticesOf(adaToken)).filter(n => n.kind === 'budget')).toHaveLength(1);
      expect((await noticesOf(linusToken)).filter(n => n.kind === 'budget')).toHaveLength(1);
    });

    it('does not tell a member who turned budget notices back on the passing already noted, nor later ones of the month', async () => {
      await setBudget('groceries', 4000);
      await setPreference('budget', false, graceToken);
      await record({ category: 'groceries', amount: 3000 });
      await record({ category: 'groceries', amount: 2000 }); // the passing: noted once, Grace not told
      await setPreference('budget', true, graceToken);
      await record({ category: 'groceries', amount: 1000 });

      expect((await noticesOf(graceToken)).filter(n => n.kind === 'budget')).toEqual([]);
      expect((await noticesOf(linusToken)).filter(n => n.kind === 'budget')).toHaveLength(1);
    });

    it('tells a member who turns budget notices on again of the next month that passes the budget', async () => {
      await setBudget('groceries', 4000);
      await setPreference('budget', false, graceToken);
      await record({ category: 'groceries', amount: 5000, date: lastDayOfLastMonth() }); // last month passes: Grace not told
      await setPreference('budget', true, graceToken);
      await record({ category: 'groceries', amount: 5000 }); // this month passes: Grace is told of it

      const budgetNotices = (await noticesOf(graceToken)).filter(n => n.kind === 'budget');
      expect(budgetNotices).toEqual([expect.objectContaining({ kind: 'budget', month: thisMonth(), budget: 4000 })]);
      expect((await noticesOf(linusToken)).filter(n => n.kind === 'budget')).toHaveLength(2);
    });
  });

  describe('reminders', () => {
    /** Ada pays 5000 split with Grace alone, so that Grace owes 2500: more than 2000. */
    async function graceOwes(): Promise<void> {
      await record({ amount: 5000, splitBetween: [adaId, graceId] });
    }

    /** Ada pays 5000 split with Linus alone, so that Linus owes 2500. */
    async function linusOwes(): Promise<void> {
      await record({ amount: 5000, splitBetween: [adaId, linusId] });
    }

    async function reminders(token: string) {
      return (await noticesOf(token)).filter(n => n.kind === 'reminder');
    }

    it('reminds no one while reminders are off, and the others are reminded as before', async () => {
      await graceOwes();
      await linusOwes();
      await setPreference('reminder', false, graceToken);
      await runAt(0);
      await runAt(7);

      expect(await reminders(graceToken)).toEqual([]);
      expect(await reminders(linusToken)).toEqual([expect.objectContaining({ kind: 'reminder', amount: 2500 })]);
    });

    it('reminds a member at the first run that would remind them once reminders are on again', async () => {
      await graceOwes();
      await runAt(0);
      await setPreference('reminder', false, graceToken);
      await runAt(7); // due, but off: not made
      await runAt(8); // still off
      expect(await reminders(graceToken)).toEqual([]);

      await setPreference('reminder', true, graceToken);
      await runAt(9);
      expect(await reminders(graceToken)).toEqual([expect.objectContaining({ kind: 'reminder', amount: 2500 })]);
    });

    it('does not count a reminder not made while off as made: the next one waits for a period after a made one', async () => {
      await graceOwes();
      await runAt(0);
      await setPreference('reminder', false, graceToken);
      await runAt(7); // not made
      await setPreference('reminder', true, graceToken);
      await runAt(9); // made: the first
      await runAt(15); // not yet a period since that one
      expect(await reminders(graceToken)).toHaveLength(1);
      await runAt(16); // a period since the first
      expect(await reminders(graceToken)).toHaveLength(2);
    });

    it('keeps a reminder made before reminders were turned off, and makes none for the time they are off', async () => {
      await graceOwes();
      await runAt(0);
      await runAt(7);
      expect(await reminders(graceToken)).toHaveLength(1);

      await setPreference('reminder', false, graceToken);
      await runAt(14);
      expect(await reminders(graceToken)).toHaveLength(1);
    });
  });

  it('refuses a kind that is not one of the three, with 422, and changes nothing', async () => {
    const answer = await setPreference('weekly', false, graceToken);
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({ type: 'InvalidKind', message: expect.any(String) });

    expect(await preferencesOf(graceToken)).toEqual(ALL_ON);
  });

  it('refuses a value of enabled that is not a boolean with 400, and changes nothing', async () => {
    const answer = await call(app, 'PUT', '/accounts/me/notice-preferences/expense', {
      body: { enabled: 'false' },
      token: graceToken,
    });
    expect(answer.status).toBe(400);

    expect(await preferencesOf(graceToken)).toEqual(ALL_ON);
  });

  it('refuses a read or a change without a signed-in account with 401', async () => {
    expect((await call(app, 'GET', '/accounts/me/notice-preferences')).status).toBe(401);
    expect((await call(app, 'GET', '/accounts/me/notice-preferences', { token: 'not-a-token' })).status).toBe(401);
    const answer = await call(app, 'PUT', '/accounts/me/notice-preferences/expense', { body: { enabled: false } });
    expect(answer.status).toBe(401);
  });
});
