import { DatabaseSync } from 'node:sqlite';
import { createApplication, type Application } from './app';
import { openDatabase } from './database';
import { send, signedUpAccount, testDirectory, type TestDirectory } from './test-helpers';

const DAY_MS = 86_400_000;
const WEEK_SECONDS = 604_800;
const WEEK_MS = WEEK_SECONDS * 1000;
const START = Date.parse('2026-11-02T09:00:00.000Z');

describe('reminders', () => {
  let directory: TestDirectory;
  let app: Application;
  let db: DatabaseSync;
  /** The time the application's clock tells; moved by the tests. */
  let now: number;

  async function startAt(options: Parameters<typeof createApplication>[0] = {}): Promise<Application> {
    const started = await createApplication({
      databasePath: directory.databasePath,
      reminderPeriodSeconds: WEEK_SECONDS,
      clock: () => new Date(now),
      ...options,
    });
    await started.start(0);
    return started;
  }

  beforeEach(async () => {
    now = START;
    directory = testDirectory();
    app = await startAt();
    db = openDatabase(directory.databasePath);
  });

  afterEach(async () => {
    db.close();
    await app.stop();
    directory.remove();
  });

  /** Bob's group, which Cy joined: answers both accounts and the group's id. */
  async function groupOfBobAndCy() {
    const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
    const cy = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
    const created = await send(app, 'POST', '/groups', { token: bob.token, body: { name: 'Flat', currency: 'EUR' } });
    const groupId = (created.body as { id: string }).id;
    const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: bob.token });
    const accepted = await send(app, 'POST', `/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: cy.token,
    });
    if (accepted.status !== 204) throw new Error(`accept answered ${accepted.status}`);
    return { bob, cy, groupId };
  }

  /** Bob pays `amount`, all of it Cy's share: Cy owes Bob `amount` more. Answers the expense's id. */
  async function cyOwesBob(bob: { id: string; token: string }, cy: { id: string }, groupId: string, amount: number) {
    const reply = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: bob.token,
      body: {
        description: 'Rent',
        amount,
        date: '2026-11-01',
        splitExactly: [
          { memberId: bob.id, amount: 0 },
          { memberId: cy.id, amount },
        ],
      },
    });
    if (reply.status !== 201) throw new Error(`expense answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** The reminders of the account of `token`, as the API answers them. */
  async function remindersOf(token: string) {
    const reply = await send(app, 'GET', '/notices', { token });
    expect(reply.status).toBe(200);
    return (reply.body as { kind: string; at: string; amount: number }[]).filter(notice => notice.kind === 'reminder');
  }

  function storedReminders(): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM notices WHERE kind = 'reminder'`).get() as { n: number }).n;
  }

  it('reminds a member who has owed more than 2000 for a period, at the sweep, and again each period while it lasts', async () => {
    const { bob, cy, groupId } = await groupOfBobAndCy();
    await cyOwesBob(bob, cy, groupId, 2500);

    app.runJobs(); // noted from now
    now += WEEK_MS - 1;
    app.runJobs();
    expect(await remindersOf(cy.token)).toEqual([]);

    now += 1; // a week since it was noted
    app.runJobs();
    const first = await remindersOf(cy.token);
    expect(first).toEqual([
      { id: expect.any(String), kind: 'reminder', groupId, amount: 2500, at: new Date(START + WEEK_MS).toISOString() },
    ]);
    expect(first[0]).not.toHaveProperty('expenseId');

    // Not again within the week, however many runs there are.
    for (let day = 1; day < 7; day += 1) {
      now = START + WEEK_MS + day * DAY_MS;
      app.runJobs();
    }
    expect(await remindersOf(cy.token)).toHaveLength(1);

    now = START + 2 * WEEK_MS;
    app.runJobs();
    const reminders = await remindersOf(cy.token);
    expect(reminders.map(reminder => reminder.at)).toEqual([
      new Date(START + 2 * WEEK_MS).toISOString(),
      new Date(START + WEEK_MS).toISOString(),
    ]);
    // Bob is owed, not owing: he is never reminded.
    expect(await remindersOf(bob.token)).toEqual([]);
  });

  it('reminds of what is still owed at the run that reminds', async () => {
    const { bob, cy, groupId } = await groupOfBobAndCy();
    await cyOwesBob(bob, cy, groupId, 2500);
    app.runJobs();
    await cyOwesBob(bob, cy, groupId, 700);
    now += WEEK_MS;
    app.runJobs();
    expect(await remindersOf(cy.token)).toMatchObject([{ amount: 3200 }]);
  });

  it('never reminds of 2000 or less', async () => {
    const { bob, cy, groupId } = await groupOfBobAndCy();
    await cyOwesBob(bob, cy, groupId, 2000);
    for (let week = 0; week < 3; week += 1) {
      app.runJobs();
      now += WEEK_MS;
    }
    expect(await remindersOf(cy.token)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lasting_debts').get()).toEqual({ n: 0 });
  });

  it('notes a debt that comes back again, from the run that sees it', async () => {
    const { bob, cy, groupId } = await groupOfBobAndCy();
    await cyOwesBob(bob, cy, groupId, 2500);
    app.runJobs(); // noted at START

    // Cy pays 1000 in cash, recorded by Bob: 1500 is still owed, and the debt is no longer noted.
    now += 3 * DAY_MS;
    const paid = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
      token: bob.token,
      body: { from: cy.id, to: bob.id, amount: 1000 },
    });
    expect(paid.status).toBe(201);
    app.runJobs();

    // It comes back: noted again from this run, not from START.
    now += DAY_MS;
    await cyOwesBob(bob, cy, groupId, 1000);
    app.runJobs();
    const notedAgainAt = now;

    now = START + WEEK_MS;
    app.runJobs();
    expect(await remindersOf(cy.token)).toEqual([]);

    now = notedAgainAt + WEEK_MS;
    app.runJobs();
    expect(await remindersOf(cy.token)).toMatchObject([{ amount: 2500, at: new Date(now).toISOString() }]);
  });

  it('makes nothing because someone read something: a read answers what is kept', async () => {
    const { bob, cy, groupId } = await groupOfBobAndCy();
    await cyOwesBob(bob, cy, groupId, 2500);
    now += 3 * WEEK_MS;
    expect(await remindersOf(cy.token)).toEqual([]);
    await send(app, 'GET', `/groups/${groupId}/balances`, { token: cy.token });
    expect(storedReminders()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lasting_debts').get()).toEqual({ n: 0 });
  });

  it('reminds a member at most once a period for a group, however many servers run on the same file', async () => {
    const { bob, cy, groupId } = await groupOfBobAndCy();
    await cyOwesBob(bob, cy, groupId, 2500);
    const others = [await startAt(), await startAt()];
    try {
      app.runJobs();
      others.forEach(other => other.runJobs());
      now += WEEK_MS;
      for (let round = 0; round < 3; round += 1) {
        app.runJobs();
        others.forEach(other => other.runJobs());
      }
      expect(storedReminders()).toBe(1);
    } finally {
      await Promise.all(others.map(other => other.stop()));
    }
  });

  it('runs the sweep by itself, every JOBS_INTERVAL_SECONDS', async () => {
    await app.stop();
    app = await startAt({ jobsIntervalSeconds: 0.05, reminderPeriodSeconds: 0.2, clock: () => new Date() });
    const { bob, cy, groupId } = await groupOfBobAndCy();
    await cyOwesBob(bob, cy, groupId, 2500);

    const deadline = Date.now() + 5000;
    while (storedReminders() === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(await remindersOf(cy.token)).toMatchObject([{ kind: 'reminder', groupId, amount: 2500 }]);
  });

  it('keeps the notices of a file written before reminders, and reminds on it', async () => {
    const { bob, cy, groupId } = await groupOfBobAndCy();
    const expenseId = await cyOwesBob(bob, cy, groupId, 2500);
    await app.stop();
    // The notices table as request 17 wrote it.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('ALTER TABLE notices RENAME TO notices_now');
    db.exec(`CREATE TABLE notices (
      id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL REFERENCES accounts (id),
      kind TEXT NOT NULL CHECK (kind IN ('expense')), group_id TEXT NOT NULL REFERENCES groups (id),
      expense_id TEXT NOT NULL, amount INTEGER NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (kind, expense_id, recipient_id))`);
    db.exec('INSERT INTO notices SELECT * FROM notices_now');
    db.exec('DROP TABLE notices_now');
    db.exec('PRAGMA foreign_keys = ON');

    app = await startAt();
    // The expense's notice was made at the real time: the reminder comes after it.
    now = Date.now();
    app.runJobs();
    now += WEEK_MS;
    app.runJobs();
    const notices = await send(app, 'GET', '/notices', { token: cy.token });
    expect(notices.body).toMatchObject([
      { kind: 'reminder', groupId, amount: 2500 },
      { kind: 'expense', groupId, expenseId, amount: 2500 },
    ]);
  });
});
