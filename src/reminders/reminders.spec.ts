import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabasePath } from '../test-support';
import { todayInUtc } from '../expenses/validation';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WEEK = 7 * DAY;
/** The start of every scenario: the background job's runs are told the time they run at. */
const START = Date.parse('2026-01-05T09:00:00.000Z');

describe('reminders', () => {
  let app: Application;
  let databasePath: string;

  beforeEach(async () => {
    databasePath = temporaryDatabasePath();
    app = await createApplication({ databasePath });
  });

  afterEach(async () => {
    await app.stop();
  });

  async function createdGroup(token: string): Promise<string> {
    const response = await send(app, 'POST', '/groups', { token, payload: { name: 'Flat 4B', currency: 'EUR' } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  /** Ada owns a group with Grace and Linus in it; answers their ids and tokens. */
  async function threeMembers() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
    const groupId = await createdGroup(ada.token);
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await joinThroughInvitation(app, ada.token, linus.token, groupId);
    return { ada, grace, linus, groupId };
  }

  /** An expense of `amount` paid by `payer`, split equally between `between`. */
  async function record(token: string, groupId: string, amount: number, between: string[]): Promise<void> {
    const response = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      payload: { description: 'Dinner', amount, date: todayInUtc(), splitBetween: between },
    });
    expect(response.statusCode).toBe(201);
  }

  /** Ada, the payee, records `amount` paid to her by `from`. */
  async function paidBy(adaToken: string, groupId: string, from: string, amount: number): Promise<void> {
    const response = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
      token: adaToken,
      payload: { from, amount },
    });
    expect(response.statusCode).toBe(201);
  }

  async function remindersOf(token: string) {
    const response = await send(app, 'GET', '/notices', { token });
    expect(response.statusCode).toBe(200);
    return response
      .json<{ id: string; kind: string; groupId: string; amount: number; at: string }[]>()
      .filter(notice => notice.kind === 'reminder');
  }

  const at = (ms: number) => new Date(ms);
  const iso = (ms: number) => new Date(ms).toISOString();

  describe('who is noted', () => {
    it('notes a member who owes more than 2000 from the run that first sees it, and reminds nobody then', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(ada.token, groupId, 4002, [ada.id, grace.id]); // Grace owes 2001.

      app.runJobs(at(START));
      expect(await remindersOf(grace.token)).toEqual([]);
      app.runJobs(at(START + WEEK - MINUTE));
      expect(await remindersOf(grace.token)).toEqual([]);
    });

    it('does not note a member who owes exactly 2000', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(ada.token, groupId, 4000, [ada.id, grace.id]); // Grace owes 2000.

      app.runJobs(at(START));
      app.runJobs(at(START + 2 * WEEK));
      expect(await remindersOf(grace.token)).toEqual([]);
    });

    it('does not note or remind a member who is owed, or owes nothing', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      await record(ada.token, groupId, 4002, [ada.id, grace.id]); // Ada is owed; Linus owes nothing.

      app.runJobs(at(START));
      app.runJobs(at(START + 2 * WEEK));
      expect(await remindersOf(ada.token)).toEqual([]);
      expect(await remindersOf(linus.token)).toEqual([]);
    });

    it('notes a debt from the run that sees it, not from a read: a read changes nothing', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(ada.token, groupId, 4002, [ada.id, grace.id]);
      await remindersOf(grace.token);
      await remindersOf(grace.token);

      // The first run to see the debt is at a week: it notes Grace then, so nothing is due yet.
      app.runJobs(at(START + WEEK));
      expect(await remindersOf(grace.token)).toEqual([]);
      app.runJobs(at(START + 2 * WEEK));
      expect(await remindersOf(grace.token)).toHaveLength(1);
    });
  });

  describe('when a member is reminded', () => {
    it('reminds a member noted for a week, at the first run a week after the note', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(ada.token, groupId, 4002, [ada.id, grace.id]);
      app.runJobs(at(START));

      app.runJobs(at(START + WEEK - MINUTE));
      expect(await remindersOf(grace.token)).toEqual([]);
      app.runJobs(at(START + WEEK));
      expect(await remindersOf(grace.token)).toEqual([
        { id: expect.any(String), kind: 'reminder', groupId, amount: 2001, at: iso(START + WEEK) },
      ]);
    });

    it('reminds again each week while the debt lasts, and not in between', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(ada.token, groupId, 4002, [ada.id, grace.id]);
      app.runJobs(at(START));

      app.runJobs(at(START + WEEK));
      app.runJobs(at(START + WEEK + MINUTE));
      app.runJobs(at(START + WEEK + 3 * DAY));
      expect(await remindersOf(grace.token)).toHaveLength(1);
      app.runJobs(at(START + 2 * WEEK));
      app.runJobs(at(START + 3 * WEEK));
      const reminders = await remindersOf(grace.token);
      expect(reminders.map(reminder => reminder.at)).toEqual([
        iso(START + 3 * WEEK),
        iso(START + 2 * WEEK),
        iso(START + WEEK),
      ]);
    });

    it('reminds with what the member still owes, which falls as they pay', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(ada.token, groupId, 4002, [ada.id, grace.id]);
      app.runJobs(at(START));
      await paidBy(ada.token, groupId, grace.id, 501); // Grace owes 1500 now: no longer over 2000.

      app.runJobs(at(START + WEEK));
      expect(await remindersOf(grace.token)).toEqual([]);
    });

    it('answers a reminder with its kind, group, amount and time, and no expense', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(ada.token, groupId, 4002, [ada.id, grace.id]);
      app.runJobs(at(START));
      app.runJobs(at(START + WEEK));

      const [reminder] = await remindersOf(grace.token);
      expect(Object.keys(reminder).sort()).toEqual(['amount', 'at', 'groupId', 'id', 'kind']);
      expect(reminder).toMatchObject({ kind: 'reminder', groupId, amount: 2001 });
    });

    it('does not note or remind a member at exactly 2000, even after a week', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(ada.token, groupId, 4002, [ada.id, grace.id]);
      app.runJobs(at(START));
      await paidBy(ada.token, groupId, grace.id, 1); // Grace owes 2000.

      app.runJobs(at(START + WEEK));
      expect(await remindersOf(grace.token)).toEqual([]);
    });
  });

  describe('when a debt comes and goes', () => {
    it('stops being noted once it is 2000 or less, and is noted again from the run that sees it returned', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(ada.token, groupId, 4002, [ada.id, grace.id]); // Grace owes 2001.
      app.runJobs(at(START));

      // Paid down to 2000: the run that sees it drops the note.
      await paidBy(ada.token, groupId, grace.id, 1);
      app.runJobs(at(START + DAY));
      // Back over 2000 (Grace owes 2500): noted again from the run at three days, not from the first note.
      await record(ada.token, groupId, 1000, [ada.id, grace.id]);
      app.runJobs(at(START + 3 * DAY));

      app.runJobs(at(START + WEEK));
      expect(await remindersOf(grace.token)).toEqual([]);
      app.runJobs(at(START + 10 * DAY));
      expect(await remindersOf(grace.token)).toEqual([
        { id: expect.any(String), kind: 'reminder', groupId, amount: 2500, at: iso(START + 10 * DAY) },
      ]);
    });

    it('drops a note for a member who has left and rejoins, so the new debt is noted afresh', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(ada.token, groupId, 4002, [ada.id, grace.id]);
      app.runJobs(at(START));

      // Grace settles to 0 and leaves, with no run in between: the note would be stale.
      await paidBy(ada.token, groupId, grace.id, 2001);
      const left = await send(app, 'POST', `/groups/${groupId}/leave`, { token: grace.token });
      expect(left.statusCode).toBeLessThan(300);
      await joinThroughInvitation(app, ada.token, grace.token, groupId);
      await record(ada.token, groupId, 4002, [ada.id, grace.id]);

      app.runJobs(at(START + WEEK));
      expect(await remindersOf(grace.token)).toEqual([]);
      app.runJobs(at(START + 2 * WEEK));
      expect(await remindersOf(grace.token)).toHaveLength(1);
    });
  });

  describe('on the same database', () => {
    it('reminds a member at most once a week, however many servers run the job on the file', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(ada.token, groupId, 4002, [ada.id, grace.id]);
      app.runJobs(at(START));

      const other = await createApplication({ databasePath });
      try {
        other.runJobs(at(START + WEEK));
        app.runJobs(at(START + WEEK));
        other.runJobs(at(START + WEEK + MINUTE));
        expect(await remindersOf(grace.token)).toHaveLength(1);

        app.runJobs(at(START + 2 * WEEK));
        expect(await remindersOf(grace.token)).toHaveLength(2);
      } finally {
        await other.stop();
      }
    });

    it('keeps its notes and reminders when the application stops and starts again on the same file', async () => {
      const { ada, grace, groupId } = await threeMembers();
      await record(ada.token, groupId, 4002, [ada.id, grace.id]);
      app.runJobs(at(START));
      app.runJobs(at(START + WEEK));
      const before = await remindersOf(grace.token);
      await app.stop();

      app = await createApplication({ databasePath });
      expect(await remindersOf(grace.token)).toEqual(before);
      app.runJobs(at(START + WEEK + MINUTE));
      expect(await remindersOf(grace.token)).toEqual(before);
      app.runJobs(at(START + 2 * WEEK));
      expect(await remindersOf(grace.token)).toHaveLength(2);
    });
  });

  it('is run by the background job on its schedule once the application starts', async () => {
    await app.stop();
    app = await createApplication({ databasePath, jobsIntervalSeconds: 0.02, reminderPeriodSeconds: 0.05 });
    const { ada, grace, groupId } = await threeMembers();
    await record(ada.token, groupId, 4002, [ada.id, grace.id]);
    await app.start(0);

    const deadline = Date.now() + 10_000;
    while ((await remindersOf(grace.token)).length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const reminders = await remindersOf(grace.token);
    expect(reminders).toEqual([expect.objectContaining({ kind: 'reminder', groupId, amount: 2001 })]);
  });
});
