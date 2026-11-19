import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabaseUrl } from '../test-support';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WEEK = 7 * DAY;
/** The start of every reminder scenario: the background job's runs are told the time they run at. */
const START = Date.parse('2026-01-05T09:00:00.000Z');

const ALL_ON = [
  { kind: 'expense', enabled: true },
  { kind: 'reminder', enabled: true },
  { kind: 'budget', enabled: true },
];

describe('notice preferences', () => {
  let app: Application;
  let databaseUrl: string;

  beforeEach(async () => {
    databaseUrl = await temporaryDatabaseUrl();
    app = await createApplication({ databaseUrl });
  });

  afterEach(async () => {
    await app.stop();
  });

  /** Ada owns a group with Grace and Linus in it, and budgets 200.00 for groceries; answers their ids and tokens. */
  async function threeMembers() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
    const created = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat 4B', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await joinThroughInvitation(app, ada.token, linus.token, groupId);
    const budget = await send(app, 'PUT', `/groups/${groupId}/budgets/groceries`, {
      token: ada.token,
      payload: { amount: 20000 },
    });
    expect(budget.statusCode).toBe(204);
    return { ada, grace, linus, groupId };
  }

  /** An expense paid by `token`'s account, split equally between `between`. */
  async function record(
    token: string,
    groupId: string,
    amount: number,
    between: string[],
    extra: { category?: string } = {},
  ): Promise<void> {
    const response = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      payload: { description: 'Shop', amount, date: todayInUtc(), splitBetween: between, ...extra },
    });
    expect(response.statusCode).toBe(201);
  }

  async function setPreference(token: string, kind: string, enabled: boolean) {
    return send(app, 'PUT', `/accounts/me/notice-preferences/${kind}`, { token, payload: { enabled } });
  }

  async function noticesOf(token: string) {
    const response = await send(app, 'GET', '/notices', { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ id: string; kind: string; groupId: string; amount: number; at: string }[]>();
  }

  async function ofKind(token: string, kind: string) {
    return (await noticesOf(token)).filter(notice => notice.kind === kind);
  }

  async function remindersOf(token: string) {
    return ofKind(token, 'reminder');
  }

  async function sweep(ms: number) {
    await app.runJobs(new Date(ms));
  }

  describe('reading them', () => {
    it('answers every kind on, in the order expense, reminder, budget, until one is turned off', async () => {
      const { ada } = await threeMembers();
      const before = await send(app, 'GET', '/accounts/me/notice-preferences', { token: ada.token });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toEqual(ALL_ON);

      expect((await setPreference(ada.token, 'reminder', false)).statusCode).toBe(204);
      const after = await send(app, 'GET', '/accounts/me/notice-preferences', { token: ada.token });
      expect(after.json()).toEqual([
        { kind: 'expense', enabled: true },
        { kind: 'reminder', enabled: false },
        { kind: 'budget', enabled: true },
      ]);
    });

    it('answers only the caller own preferences, and reading them changes none', async () => {
      const { ada, grace } = await threeMembers();
      expect((await setPreference(grace.token, 'expense', false)).statusCode).toBe(204);

      expect((await send(app, 'GET', '/accounts/me/notice-preferences', { token: ada.token })).json()).toEqual(ALL_ON);
      const first = await send(app, 'GET', '/accounts/me/notice-preferences', { token: grace.token });
      const second = await send(app, 'GET', '/accounts/me/notice-preferences', { token: grace.token });
      expect(first.json()).toEqual(second.json());
      expect(first.json()).toEqual([
        { kind: 'expense', enabled: false },
        { kind: 'reminder', enabled: true },
        { kind: 'budget', enabled: true },
      ]);
    });

    it('turns a kind on again, and answers it on', async () => {
      const { ada } = await threeMembers();
      await setPreference(ada.token, 'budget', false);
      expect((await setPreference(ada.token, 'budget', true)).statusCode).toBe(204);
      expect((await send(app, 'GET', '/accounts/me/notice-preferences', { token: ada.token })).json()).toEqual(ALL_ON);
    });
  });

  describe('expense notices', () => {
    it('stops making them for a member who turned them off, from then on, and nothing made earlier changes', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const between = [ada.id, grace.id, linus.id];
      await record(ada.token, groupId, 3000, between); // a share of 1000 each
      const made = await ofKind(grace.token, 'expense');
      expect(made.map(notice => notice.amount)).toEqual([1000]);

      expect((await setPreference(grace.token, 'expense', false)).statusCode).toBe(204);
      await record(ada.token, groupId, 3000, between);

      expect(await ofKind(grace.token, 'expense')).toEqual(made);
      expect(await ofKind(linus.token, 'expense')).toHaveLength(2);
    });

    it('does not make, later, the notices missed while it was off', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const between = [ada.id, grace.id, linus.id];
      await setPreference(grace.token, 'expense', false);
      await record(ada.token, groupId, 3000, between);
      await setPreference(grace.token, 'expense', true);
      expect(await ofKind(grace.token, 'expense')).toEqual([]);

      await record(ada.token, groupId, 3000, between);
      expect(await ofKind(grace.token, 'expense')).toHaveLength(1);
    });

    it('leaves the others of the group told as before', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      await setPreference(grace.token, 'expense', false);
      await record(ada.token, groupId, 3000, [ada.id, grace.id, linus.id]);

      expect(await ofKind(grace.token, 'expense')).toEqual([]);
      expect(await ofKind(linus.token, 'expense')).toHaveLength(1);
      expect(await ofKind(ada.token, 'expense')).toEqual([]); // the payer is never told of their own expense
    });
  });

  describe('budget notices', () => {
    it('is not made for a member who turned them off, and a passing missed while off is not made later', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      await setPreference(grace.token, 'budget', false);
      await record(ada.token, groupId, 25000, [ada.id, grace.id, linus.id], { category: 'groceries' });

      expect(await ofKind(grace.token, 'budget')).toEqual([]);
      expect(await ofKind(linus.token, 'budget')).toHaveLength(1);
      expect(await ofKind(ada.token, 'budget')).toHaveLength(1);

      await setPreference(grace.token, 'budget', true);
      expect(await ofKind(grace.token, 'budget')).toEqual([]);
      // The month is told once for the group: a further expense in it makes no notice for anyone.
      await record(ada.token, groupId, 1000, [ada.id, grace.id, linus.id], { category: 'groceries' });
      expect(await ofKind(grace.token, 'budget')).toEqual([]);
      expect(await ofKind(linus.token, 'budget')).toHaveLength(1);
    });
  });

  describe('reminders', () => {
    it('a reminder not made while they are off does not count as made: the next run that would remind is when they are on', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      await record(ada.token, groupId, 4002, [ada.id, grace.id]); // Grace owes 2001
      await record(ada.token, groupId, 4002, [ada.id, linus.id]); // Linus owes 2001
      await sweep(START); // both noted

      expect((await setPreference(grace.token, 'reminder', false)).statusCode).toBe(204);
      await sweep(START + WEEK); // Linus is reminded; Grace is not, her reminders being off
      expect(await remindersOf(grace.token)).toEqual([]);
      expect(await remindersOf(linus.token)).toEqual([
        { id: expect.any(String), kind: 'reminder', groupId, amount: 2001, at: new Date(START + WEEK).toISOString() },
      ]);

      await setPreference(grace.token, 'reminder', true);
      await sweep(START + WEEK + DAY); // the next run that would remind Grace
      expect(await remindersOf(grace.token)).toEqual([
        {
          id: expect.any(String),
          kind: 'reminder',
          groupId,
          amount: 2001,
          at: new Date(START + WEEK + DAY).toISOString(),
        },
      ]);
      // Linus, reminded this period already, is not reminded again by the same run.
      expect(await remindersOf(linus.token)).toHaveLength(1);
    });
  });

  describe('refusals', () => {
    it('refuses a kind that is none of the three, changing nothing', async () => {
      const { ada } = await threeMembers();
      const response = await setPreference(ada.token, 'rent', false);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ type: 'InvalidNoticeKind' });
      expect((await send(app, 'GET', '/accounts/me/notice-preferences', { token: ada.token })).json()).toEqual(ALL_ON);
    });

    it('refuses an enabled that is not a boolean', async () => {
      const { ada } = await threeMembers();
      const response = await send(app, 'PUT', '/accounts/me/notice-preferences/expense', {
        token: ada.token,
        payload: { enabled: 'no' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('is refused without a signed-in account, for reading and for changing', async () => {
      await threeMembers();
      expect((await send(app, 'GET', '/accounts/me/notice-preferences', {})).statusCode).toBe(401);
      expect(
        (await send(app, 'PUT', '/accounts/me/notice-preferences/expense', { payload: { enabled: false } })).statusCode,
      ).toBe(401);
    });
  });
});
