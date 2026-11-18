import { DatabaseSync } from 'node:sqlite';
import { createApplication, type Application } from './app';
import { type Database, openDatabase } from './database';
import { createLegacyFile } from './legacy-file';
import { hashPassword } from './passwords';
import { ensureDatabase, send, signedUpAccount, testDirectory, type TestDirectory } from './test-helpers';

const DAY_MS = 86_400_000;
const WEEK_SECONDS = 604_800;
const WEEK_MS = WEEK_SECONDS * 1000;
const START = Date.parse('2026-11-02T09:00:00.000Z');

describe('reminders', () => {
  let directory: TestDirectory;
  let app: Application;
  let db: Database;
  /** The time the application's clock tells; moved by the tests. */
  let now: number;

  async function startAt(options: Parameters<typeof createApplication>[0] = {}): Promise<Application> {
    await ensureDatabase(directory.databaseUrl);
    const started = await createApplication({
      databaseUrl: directory.databaseUrl,
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
    db = await openDatabase({ url: directory.databaseUrl });
  });

  afterEach(async () => {
    await db.close();
    await app.stop();
    await directory.remove();
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

  async function storedReminders(): Promise<number> {
    return ((await db.prepare(`SELECT COUNT(*) AS n FROM notices WHERE kind = 'reminder'`).get()) as { n: number }).n;
  }

  it('reminds a member who has owed more than 2000 for a period, at the sweep, and again each period while it lasts', async () => {
    const { bob, cy, groupId } = await groupOfBobAndCy();
    await cyOwesBob(bob, cy, groupId, 2500);

    await app.runJobs(); // noted from now
    now += WEEK_MS - 1;
    await app.runJobs();
    expect(await remindersOf(cy.token)).toEqual([]);

    now += 1; // a week since it was noted
    await app.runJobs();
    const first = await remindersOf(cy.token);
    expect(first).toEqual([
      { id: expect.any(String), kind: 'reminder', groupId, amount: 2500, at: new Date(START + WEEK_MS).toISOString() },
    ]);
    expect(first[0]).not.toHaveProperty('expenseId');

    // Not again within the week, however many runs there are.
    for (let day = 1; day < 7; day += 1) {
      now = START + WEEK_MS + day * DAY_MS;
      await app.runJobs();
    }
    expect(await remindersOf(cy.token)).toHaveLength(1);

    now = START + 2 * WEEK_MS;
    await app.runJobs();
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
    await app.runJobs();
    await cyOwesBob(bob, cy, groupId, 700);
    now += WEEK_MS;
    await app.runJobs();
    expect(await remindersOf(cy.token)).toMatchObject([{ amount: 3200 }]);
  });

  it('never reminds of 2000 or less', async () => {
    const { bob, cy, groupId } = await groupOfBobAndCy();
    await cyOwesBob(bob, cy, groupId, 2000);
    for (let week = 0; week < 3; week += 1) {
      await app.runJobs();
      now += WEEK_MS;
    }
    expect(await remindersOf(cy.token)).toEqual([]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM lasting_debts').get()).toEqual({ n: 0 });
  });

  it('notes a debt that comes back again, from the run that sees it', async () => {
    const { bob, cy, groupId } = await groupOfBobAndCy();
    await cyOwesBob(bob, cy, groupId, 2500);
    await app.runJobs(); // noted at START

    // Cy pays 1000 in cash, recorded by Bob: 1500 is still owed, and the debt is no longer noted.
    now += 3 * DAY_MS;
    const paid = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
      token: bob.token,
      body: { from: cy.id, to: bob.id, amount: 1000 },
    });
    expect(paid.status).toBe(201);
    await app.runJobs();

    // It comes back: noted again from this run, not from START.
    now += DAY_MS;
    await cyOwesBob(bob, cy, groupId, 1000);
    await app.runJobs();
    const notedAgainAt = now;

    now = START + WEEK_MS;
    await app.runJobs();
    expect(await remindersOf(cy.token)).toEqual([]);

    now = notedAgainAt + WEEK_MS;
    await app.runJobs();
    expect(await remindersOf(cy.token)).toMatchObject([{ amount: 2500, at: new Date(now).toISOString() }]);
  });

  it('makes no reminder to a member who turned them off, and reminds them at the first run that does once they are on again', async () => {
    const { bob, cy, groupId } = await groupOfBobAndCy();
    await cyOwesBob(bob, cy, groupId, 2500);
    await app.runJobs(); // noted from START
    const off = await send(app, 'PUT', '/accounts/me/notice-preferences/reminder', {
      token: cy.token,
      body: { enabled: false },
    });
    expect(off.status).toBe(204);

    // A week on, the debt has lasted, but Cy has reminders off: nothing is made, and nothing counts as made.
    now += WEEK_MS;
    await app.runJobs();
    expect(await remindersOf(cy.token)).toEqual([]);
    expect(await storedReminders()).toBe(0);

    // On again a day later, still owing: the run that sees it reminds Cy at once, not a week after.
    now += DAY_MS;
    const on = await send(app, 'PUT', '/accounts/me/notice-preferences/reminder', {
      token: cy.token,
      body: { enabled: true },
    });
    expect(on.status).toBe(204);
    await app.runJobs();
    expect(await remindersOf(cy.token)).toEqual([
      { id: expect.any(String), kind: 'reminder', groupId, amount: 2500, at: new Date(now).toISOString() },
    ]);
  });

  it('reminds the others of the group as before while one member has reminders off', async () => {
    const { bob, cy, groupId } = await groupOfBobAndCy();
    const di = await signedUpAccount(app, { email: 'di@example.com', name: 'Di' });
    const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: bob.token });
    const accepted = await send(app, 'POST', `/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: di.token,
    });
    expect(accepted.status).toBe(204);
    await cyOwesBob(bob, cy, groupId, 2500);
    const diReply = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: bob.token,
      body: {
        description: 'Tickets',
        amount: 2500,
        date: '2026-11-01',
        splitExactly: [
          { memberId: bob.id, amount: 0 },
          { memberId: di.id, amount: 2500 },
        ],
      },
    });
    expect(diReply.status).toBe(201);
    expect(
      (
        await send(app, 'PUT', '/accounts/me/notice-preferences/reminder', {
          token: cy.token,
          body: { enabled: false },
        })
      ).status,
    ).toBe(204);

    await app.runJobs();
    now += WEEK_MS;
    await app.runJobs();
    expect(await remindersOf(cy.token)).toEqual([]);
    expect(await remindersOf(di.token)).toMatchObject([{ kind: 'reminder', groupId, amount: 2500 }]);
  });

  it('makes nothing because someone read something: a read answers what is kept', async () => {
    const { bob, cy, groupId } = await groupOfBobAndCy();
    await cyOwesBob(bob, cy, groupId, 2500);
    now += 3 * WEEK_MS;
    expect(await remindersOf(cy.token)).toEqual([]);
    await send(app, 'GET', `/groups/${groupId}/balances`, { token: cy.token });
    expect(await storedReminders()).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM lasting_debts').get()).toEqual({ n: 0 });
  });

  it('reminds a member at most once a period for a group, however many servers run on the same file', async () => {
    const { bob, cy, groupId } = await groupOfBobAndCy();
    await cyOwesBob(bob, cy, groupId, 2500);
    const others = [await startAt(), await startAt()];
    try {
      await app.runJobs();
      for (const other of others) await other.runJobs();
      now += WEEK_MS;
      for (let round = 0; round < 3; round += 1) {
        await app.runJobs();
        for (const other of others) await other.runJobs();
      }
      expect(await storedReminders()).toBe(1);
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
    while ((await storedReminders()) === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(await remindersOf(cy.token)).toMatchObject([{ kind: 'reminder', groupId, amount: 2500 }]);
  });
});

describe('reminders of a file written before reminders', () => {
  const EXPENSE_TIME = '2026-11-02T09:00:00.000Z';
  let directory: TestDirectory;
  let now: number;

  beforeEach(() => {
    now = START;
    directory = testDirectory();
  });

  afterEach(async () => {
    await directory.remove();
  });

  it('keeps the notices of a file written before reminders, and reminds on it', async () => {
    // A file of the earlier version: Bob and Cy in a group, Bob's expense of 2500 of which Cy owes all, and its
    // notice for Cy, in the notices table as request 17 wrote it (before reminders could be a kind of notice).
    createLegacyFile(directory.legacyPath);
    const passwordHash = await hashPassword('correct horse');
    const file = new DatabaseSync(directory.legacyPath);
    try {
      file.exec('DROP TABLE notices');
      file.exec(`CREATE TABLE notices (
        id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL REFERENCES accounts (id),
        kind TEXT NOT NULL CHECK (kind IN ('expense')), group_id TEXT NOT NULL REFERENCES groups (id),
        expense_id TEXT NOT NULL, amount INTEGER NOT NULL, created_at TEXT NOT NULL,
        UNIQUE (kind, expense_id, recipient_id))`);
      const insert = (sql: string, ...params: unknown[]) => file.prepare(sql).run(...(params as never[]));
      insert(
        'INSERT INTO accounts (id, email, email_key, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        'bob-id',
        'bob@example.com',
        'bob@example.com',
        'Bob',
        passwordHash,
        EXPENSE_TIME,
      );
      insert(
        'INSERT INTO accounts (id, email, email_key, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        'cy-id',
        'cy@example.com',
        'cy@example.com',
        'Cy',
        passwordHash,
        EXPENSE_TIME,
      );
      insert(
        'INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES (?, ?, ?, ?, ?)',
        'flat-group',
        'Flat',
        'EUR',
        'bob-id',
        EXPENSE_TIME,
      );
      insert(
        'INSERT INTO group_members (group_id, account_id, joined_at) VALUES (?, ?, ?)',
        'flat-group',
        'bob-id',
        EXPENSE_TIME,
      );
      insert(
        'INSERT INTO group_members (group_id, account_id, joined_at) VALUES (?, ?, ?)',
        'flat-group',
        'cy-id',
        EXPENSE_TIME,
      );
      insert(
        `INSERT INTO expenses (id, group_id, description, amount, spent_on, paid_by, version, split_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        'rent-expense',
        'flat-group',
        'Rent',
        2500,
        '2026-11-01',
        'bob-id',
        1,
        'exact',
        EXPENSE_TIME,
      );
      insert(
        'INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)',
        'rent-expense',
        0,
        'bob-id',
        0,
      );
      insert(
        'INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)',
        'rent-expense',
        1,
        'cy-id',
        2500,
      );
      insert(
        `INSERT INTO notices (id, recipient_id, kind, group_id, expense_id, amount, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        'expense-notice',
        'cy-id',
        'expense',
        'flat-group',
        'rent-expense',
        2500,
        EXPENSE_TIME,
      );
    } finally {
      await file.close();
    }

    await ensureDatabase(directory.databaseUrl);
    const started = await createApplication({
      databaseUrl: directory.databaseUrl,
      databasePath: directory.legacyPath,
      reminderPeriodSeconds: WEEK_SECONDS,
      clock: () => new Date(now),
    });
    await started.start(0);
    try {
      const login = await send(started, 'POST', '/accounts/login', {
        body: { email: 'cy@example.com', password: 'correct horse' },
      });
      const cyToken = (login.body as { token: string }).token;
      // The expense's notice was made at its time: the reminder comes after it.
      now = Date.now();
      await started.runJobs();
      now += WEEK_MS;
      await started.runJobs();
      const notices = await send(started, 'GET', '/notices', { token: cyToken });
      expect(notices.body).toMatchObject([
        { kind: 'reminder', groupId: 'flat-group', amount: 2500 },
        { kind: 'expense', groupId: 'flat-group', expenseId: 'rent-expense', amount: 2500 },
      ]);
    } finally {
      await started.stop();
    }
  });
});
