import { DatabaseSync } from 'node:sqlite';
import { createApplication, type Application } from './app';
import { openDatabase } from './database';
import { createLegacyFile } from './legacy-file';
import { ensureDatabase, send, signedUpAccount, testDirectory, type TestDirectory } from './test-helpers';

const START = Date.parse('2026-11-10T09:00:00.000Z');

interface Member {
  id: string;
  token: string;
}

/** A budget's notice, as the API answers it. */
interface BudgetNotice {
  id: string;
  kind: 'budget';
  groupId: string;
  category: string;
  month: string;
  budget: number;
  amount: number;
  at: string;
}

describe('budgets', () => {
  let directory: TestDirectory;
  let app: Application;
  /** The time the application's clock tells; moved by the tests. */
  let now: number;

  async function startAt(databaseUrl = directory.databaseUrl, databasePath = ''): Promise<Application> {
    await ensureDatabase(databaseUrl);
    const started = await createApplication({
      databaseUrl,
      databasePath,
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

  /** An expense of `amount` on `date`, split equally between `members`, the payer among them. */
  const shop = (members: Member[], amount: number, date: string, extra: Record<string, unknown> = {}) => ({
    description: 'Shop',
    amount,
    date,
    splitBetween: members.map(member => member.id),
    ...extra,
  });

  async function recordOk(token: string, groupId: string, body: Record<string, unknown>): Promise<string> {
    const reply = await send(app, 'POST', `/groups/${groupId}/expenses`, { token, body });
    if (reply.status !== 201) throw new Error(`expense answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  async function setBudget(token: string, groupId: string, category: string, amount: number): Promise<void> {
    const reply = await send(app, 'PUT', `/groups/${groupId}/budgets/${category}`, { token, body: { amount } });
    if (reply.status !== 204) throw new Error(`budget answered ${reply.status}`);
  }

  /** The budget notices of the account of `token`, the most recent first, as the API answers them. */
  async function budgetNoticesOf(token: string): Promise<BudgetNotice[]> {
    const reply = await send(app, 'GET', '/notices', { token });
    expect(reply.status).toBe(200);
    return (reply.body as { kind: string }[]).filter((notice): notice is BudgetNotice => notice.kind === 'budget');
  }

  it('reads an expense in other unless it is given a category, and a category that is not one is refused', async () => {
    const { bob, cy, dee, groupId } = await household();
    const members = [bob, cy, dee];
    const plain = await recordOk(bob.token, groupId, shop(members, 900, '2026-11-02'));
    const groceries = await recordOk(bob.token, groupId, shop(members, 600, '2026-11-02', { category: 'groceries' }));
    expect((await send(app, 'GET', `/expenses/${plain}`, { token: cy.token })).body).toMatchObject({
      category: 'other',
    });
    expect((await send(app, 'GET', `/expenses/${groceries}`, { token: cy.token })).body).toMatchObject({
      category: 'groceries',
    });

    const refused = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: bob.token,
      body: shop(members, 100, '2026-11-02', { category: 'snacks' }),
    });
    expect(refused).toMatchObject({ status: 422, body: { error: 'CategoryIsUnsupported' } });
    expect(await send(app, 'GET', `/groups/${groupId}/expenses`, { token: bob.token })).toMatchObject({
      body: [{ id: groceries }, { id: plain }],
    });
  });

  it('edits the category of an expense, and an edit that gives none makes it other', async () => {
    const { bob, cy, dee, groupId } = await household();
    const members = [bob, cy, dee];
    const id = await recordOk(bob.token, groupId, shop(members, 900, '2026-11-02', { category: 'food' }));
    const rent = await send(app, 'PUT', `/expenses/${id}`, {
      token: bob.token,
      body: shop(members, 900, '2026-11-02', { category: 'rent', version: 1 }),
    });
    expect(rent).toMatchObject({ status: 200, body: { category: 'rent', version: 2 } });
    const plain = await send(app, 'PUT', `/expenses/${id}`, {
      token: bob.token,
      body: shop(members, 900, '2026-11-02', { version: 2 }),
    });
    expect(plain).toMatchObject({ status: 200, body: { category: 'other', version: 3 } });
    const refused = await send(app, 'PUT', `/expenses/${id}`, {
      token: bob.token,
      body: shop(members, 900, '2026-11-02', { category: 'snacks', version: 3 }),
    });
    expect(refused).toMatchObject({ status: 422, body: { error: 'CategoryIsUnsupported' } });
  });

  it('gives a recurring expense its category, and the expenses the background job records have it', async () => {
    const { bob, cy, dee, groupId } = await household();
    const members = [bob, cy, dee];
    const water = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: bob.token,
      body: {
        description: 'Water',
        amount: 1001,
        startsOn: '2026-10-05',
        category: 'utilities',
        splitBetween: members.map(member => member.id),
      },
    });
    const gym = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: bob.token,
      body: { description: 'Gym', amount: 500, startsOn: '2026-10-05', splitBetween: members.map(member => member.id) },
    });
    expect(
      await send(app, 'GET', `/recurring/${(water.body as { id: string }).id}`, { token: cy.token }),
    ).toMatchObject({
      body: { category: 'utilities' },
    });
    expect(await send(app, 'GET', `/recurring/${(gym.body as { id: string }).id}`, { token: cy.token })).toMatchObject({
      body: { category: 'other' },
    });

    await app.runJobs();
    const expenses = (await send(app, 'GET', `/groups/${groupId}/expenses`, { token: cy.token })).body as {
      description: string;
      date: string;
      category: string;
    }[];
    expect(expenses.filter(expense => expense.description === 'Water').map(expense => expense.date)).toEqual([
      '2026-11-05',
      '2026-10-05',
    ]);
    expect(expenses.filter(expense => expense.description === 'Water').map(expense => expense.category)).toEqual([
      'utilities',
      'utilities',
    ]);
    expect(expenses.filter(expense => expense.description === 'Gym').map(expense => expense.category)).toEqual([
      'other',
      'other',
    ]);
  });

  it('sets a budget, replaces it and removes it, only its owner doing so', async () => {
    const { bob, cy, groupId } = await household();
    const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
    const url = `/groups/${groupId}/budgets/groceries`;

    expect(await send(app, 'PUT', url, { token: bob.token, body: { amount: 40000 } })).toMatchObject({ status: 204 });
    expect((await send(app, 'GET', `/groups/${groupId}/budgets`, { token: cy.token })).body).toEqual([
      { category: 'groceries', amount: 40000, spent: 0 },
    ]);
    expect(await send(app, 'PUT', url, { token: bob.token, body: { amount: 45000 } })).toMatchObject({ status: 204 });
    expect((await send(app, 'GET', `/groups/${groupId}/budgets`, { token: cy.token })).body).toEqual([
      { category: 'groceries', amount: 45000, spent: 0 },
    ]);

    // A member other than the owner is refused, and changes nothing.
    expect(await send(app, 'PUT', url, { token: cy.token, body: { amount: 1 } })).toMatchObject({
      status: 403,
      body: { error: 'NotOwner' },
    });
    expect(await send(app, 'DELETE', url, { token: cy.token })).toMatchObject({ status: 403 });
    expect((await send(app, 'GET', `/groups/${groupId}/budgets`, { token: cy.token })).body).toEqual([
      { category: 'groceries', amount: 45000, spent: 0 },
    ]);
    // Someone who is not a member does not see the group.
    expect(await send(app, 'PUT', url, { token: eve.token, body: { amount: 1 } })).toMatchObject({ status: 404 });
    expect(await send(app, 'GET', `/groups/${groupId}/budgets`, { token: eve.token })).toMatchObject({ status: 404 });

    expect(await send(app, 'DELETE', url, { token: bob.token })).toMatchObject({ status: 204 });
    expect((await send(app, 'GET', `/groups/${groupId}/budgets`, { token: cy.token })).body).toEqual([]);
    expect(await send(app, 'DELETE', url, { token: bob.token })).toMatchObject({ status: 204 });
  });

  it('refuses a budget whose category is not one of the categories, or whose amount is out of 1 to 100 000 000', async () => {
    const { bob, groupId } = await household();
    const put = (category: string, body: unknown) =>
      send(app, 'PUT', `/groups/${groupId}/budgets/${category}`, { token: bob.token, body });

    expect(await put('snacks', { amount: 1000 })).toMatchObject({
      status: 422,
      body: { error: 'CategoryIsUnsupported' },
    });
    for (const amount of [0, 100_000_001, 1.5]) {
      expect(await put('food', { amount })).toMatchObject({ status: 422, body: { error: 'BudgetAmountIsInvalid' } });
    }
    expect(await put('food', { amount: '40' })).toMatchObject({ status: 400 });
    expect(await put('food', {})).toMatchObject({ status: 400 });
    expect(await put('food', { amount: 1 })).toMatchObject({ status: 204 });
    expect(await put('food', { amount: 100_000_000 })).toMatchObject({ status: 204 });
  });

  it('reads the budgets in the order of the categories, with what the current month spends in each', async () => {
    const { bob, cy, dee, groupId } = await household();
    const members = [bob, cy, dee];
    await setBudget(bob.token, groupId, 'travel', 30000);
    await setBudget(bob.token, groupId, 'groceries', 40000);
    await setBudget(bob.token, groupId, 'other', 5000);

    await recordOk(bob.token, groupId, shop(members, 1000, '2026-11-02', { category: 'groceries' }));
    await recordOk(cy.token, groupId, shop(members, 2500, '2026-11-09', { category: 'groceries' }));
    await recordOk(bob.token, groupId, shop(members, 9000, '2026-10-31', { category: 'groceries' }));
    await recordOk(bob.token, groupId, shop(members, 300, '2026-11-01', { category: 'travel' }));
    const deleted = await recordOk(bob.token, groupId, shop(members, 700, '2026-11-03', { category: 'groceries' }));
    expect((await send(app, 'DELETE', `/expenses/${deleted}`, { token: bob.token })).status).toBe(204);

    const budgets = `/groups/${groupId}/budgets`;
    expect((await send(app, 'GET', budgets, { token: cy.token })).body).toEqual([
      { category: 'groceries', amount: 40000, spent: 3500 },
      { category: 'travel', amount: 30000, spent: 300 },
      { category: 'other', amount: 5000, spent: 0 },
    ]);

    // The month is the UTC month of the clock: the 31st of October, at 23:30 UTC, is October's.
    now = Date.parse('2026-10-31T23:30:00.000Z');
    expect((await send(app, 'GET', budgets, { token: cy.token })).body).toEqual([
      { category: 'groceries', amount: 40000, spent: 9000 },
      { category: 'travel', amount: 30000, spent: 0 },
      { category: 'other', amount: 5000, spent: 0 },
    ]);
  });

  it('notices every member, the payer too, once when a month passes its budget, with what the month spends', async () => {
    const { bob, cy, dee, groupId } = await household();
    const members = [bob, cy, dee];
    await setBudget(bob.token, groupId, 'groceries', 1000);

    await recordOk(bob.token, groupId, shop(members, 600, '2026-11-02', { category: 'groceries' }));
    for (const member of members) expect(await budgetNoticesOf(member.token)).toEqual([]);

    await recordOk(cy.token, groupId, shop(members, 500, '2026-11-03', { category: 'groceries' }));
    for (const member of members) {
      expect(await budgetNoticesOf(member.token)).toEqual([
        {
          id: expect.any(String),
          kind: 'budget',
          groupId,
          category: 'groceries',
          month: '2026-11',
          budget: 1000,
          amount: 1100,
          at: expect.any(String),
        },
      ]);
    }
    const [notice] = await budgetNoticesOf(bob.token);
    expect(notice).not.toHaveProperty('expenseId');
  });

  it('makes no other notice for a month and category, however far over it goes, or however often it comes back over', async () => {
    const { bob, cy, dee, groupId } = await household();
    const members = [bob, cy, dee];
    await setBudget(bob.token, groupId, 'groceries', 1000);
    await recordOk(bob.token, groupId, shop(members, 600, '2026-11-02', { category: 'groceries' }));
    const cys = await recordOk(cy.token, groupId, shop(members, 500, '2026-11-03', { category: 'groceries' }));
    // November is over: 1 100 at once, noticed.
    await recordOk(bob.token, groupId, shop(members, 300, '2026-11-04', { category: 'groceries' }));
    // Back under: Cy's expense is 100, November is 1 000, not over.
    const back = await send(app, 'PUT', `/expenses/${cys}`, {
      token: cy.token,
      body: shop(members, 100, '2026-11-03', { category: 'groceries', version: 1 }),
    });
    expect(back.status).toBe(200);
    // Over again: 1 500. Noticed no more.
    await recordOk(dee.token, groupId, shop(members, 500, '2026-11-05', { category: 'groceries' }));
    for (const member of members) {
      expect(await budgetNoticesOf(member.token)).toMatchObject([{ month: '2026-11', amount: 1100 }]);
    }

    // Another month is its own month: October is over by 1 500, noticed once.
    await recordOk(bob.token, groupId, shop(members, 1500, '2026-10-05', { category: 'groceries' }));
    for (const member of members) {
      const notices = await budgetNoticesOf(member.token);
      expect(notices.map(notice => [notice.month, notice.amount])).toEqual([
        ['2026-10', 1500],
        ['2026-11', 1100],
      ]);
    }
  });

  it('notices a month an edit leaves over its budget, in the category the edit gives, as a record does', async () => {
    const { bob, cy, dee, groupId } = await household();
    const members = [bob, cy, dee];
    await setBudget(bob.token, groupId, 'transport', 1000);
    await setBudget(bob.token, groupId, 'groceries', 500);
    const id = await recordOk(bob.token, groupId, shop(members, 800, '2026-11-02', { category: 'transport' }));
    for (const member of members) expect(await budgetNoticesOf(member.token)).toEqual([]);

    const grown = await send(app, 'PUT', `/expenses/${id}`, {
      token: bob.token,
      body: shop(members, 1200, '2026-11-02', { category: 'transport', version: 1 }),
    });
    expect(grown.status).toBe(200);
    for (const member of members) {
      expect(await budgetNoticesOf(member.token)).toMatchObject([
        { category: 'transport', month: '2026-11', budget: 1000, amount: 1200 },
      ]);
    }

    const moved = await send(app, 'PUT', `/expenses/${id}`, {
      token: bob.token,
      body: shop(members, 1200, '2026-11-02', { category: 'groceries', version: 2 }),
    });
    expect(moved.status).toBe(200);
    for (const member of members) {
      expect((await budgetNoticesOf(member.token)).map(notice => [notice.category, notice.amount]).sort()).toEqual([
        ['groceries', 1200],
        ['transport', 1200],
      ]);
    }
  });

  it('makes no notice by setting or changing a budget, nor by a read, and notices the next record of a passed month', async () => {
    const { bob, cy, dee, groupId } = await household();
    const members = [bob, cy, dee];
    await recordOk(bob.token, groupId, shop(members, 2000, '2026-11-02', { category: 'groceries' }));
    await setBudget(bob.token, groupId, 'groceries', 1000);
    for (const member of members) expect(await budgetNoticesOf(member.token)).toEqual([]);
    // The budget reads as over; the read makes no notice.
    expect((await send(app, 'GET', `/groups/${groupId}/budgets`, { token: cy.token })).body).toEqual([
      { category: 'groceries', amount: 1000, spent: 2000 },
    ]);
    for (const member of members) expect(await budgetNoticesOf(member.token)).toEqual([]);

    await recordOk(bob.token, groupId, shop(members, 1, '2026-11-02', { category: 'groceries' }));
    for (const member of members) {
      expect(await budgetNoticesOf(member.token)).toMatchObject([{ budget: 1000, amount: 2001 }]);
    }
    await setBudget(bob.token, groupId, 'groceries', 5000);
    for (const member of members) expect(await budgetNoticesOf(member.token)).toHaveLength(1);
  });

  it('notices a month the background job passes with the recurring expenses it records, as a record does', async () => {
    const { bob, cy, dee, groupId } = await household();
    const members = [bob, cy, dee];
    await setBudget(bob.token, groupId, 'groceries', 1000);
    const created = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: bob.token,
      body: {
        description: 'Shop',
        amount: 1001,
        startsOn: '2026-10-05',
        category: 'groceries',
        splitBetween: members.map(member => member.id),
      },
    });
    expect(created.status).toBe(201);

    await app.runJobs();
    await app.runJobs();
    for (const member of members) {
      const notices = await budgetNoticesOf(member.token);
      expect(notices.map(notice => [notice.month, notice.amount, notice.budget]).sort()).toEqual([
        ['2026-10', 1001, 1000],
        ['2026-11', 1001, 1000],
      ]);
    }
  });

  it('notices a month once however many times the server restarts, and a restart repeats none', async () => {
    const { bob, cy, dee, groupId } = await household();
    const members = [bob, cy, dee];
    await setBudget(bob.token, groupId, 'groceries', 1000);
    await recordOk(bob.token, groupId, shop(members, 1500, '2026-11-02', { category: 'groceries' }));
    await app.stop();

    app = await startAt();
    await app.runJobs();
    await recordOk(cy.token, groupId, shop(members, 200, '2026-11-03', { category: 'groceries' }));
    for (const member of members) {
      expect(await budgetNoticesOf(member.token)).toMatchObject([{ month: '2026-11', amount: 1500 }]);
    }
  });

  it('keeps a file written before categories and budgets: its expenses are other, its notices kept, and budgets work on it', async () => {
    const { bob, cy, dee, groupId } = await household();
    const members = [bob, cy, dee];
    const expenseId = await recordOk(bob.token, groupId, shop(members, 900, '2026-11-02'));
    const recurring = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: bob.token,
      body: { description: 'Gym', amount: 500, startsOn: '2026-10-05', splitBetween: members.map(member => member.id) },
    });
    const recurringId = (recurring.body as { id: string }).id;
    await app.stop();
    await writeEarlierFile(directory.databaseUrl, directory.legacyPath);
    const migrated = testDirectory();
    app = await startAt(migrated.databaseUrl, directory.legacyPath);
    try {
      expect(await send(app, 'GET', `/expenses/${expenseId}`, { token: cy.token })).toMatchObject({
        body: { id: expenseId, category: 'other' },
      });
      expect(await send(app, 'GET', `/recurring/${recurringId}`, { token: cy.token })).toMatchObject({
        body: { id: recurringId, category: 'other' },
      });
      expect(await send(app, 'GET', '/notices', { token: cy.token })).toMatchObject({
        body: [{ kind: 'expense', expenseId, amount: 300 }],
      });

      await setBudget(bob.token, groupId, 'other', 1000);
      // The 900 recorded before the file's categories is `other` too: November's `other` spends 900 + 1 500.
      await recordOk(bob.token, groupId, shop(members, 1500, '2026-11-03'));
      for (const member of members) {
        expect(await budgetNoticesOf(member.token)).toMatchObject([
          { category: 'other', month: '2026-11', budget: 1000, amount: 2400 },
        ]);
      }
    } finally {
      await migrated.remove();
    }
  });
});

/**
 * Writes the SQLite file at `path` as Tally left the database at `url` before categories and budgets: every row of the
 * database, in the file's tables, with the tables rebuilt as `writeFileBeforeCategories` has them.
 */
async function writeEarlierFile(url: string, path: string): Promise<void> {
  const db = await openDatabase({ url });
  const tables: { name: string; rows: Record<string, unknown>[] }[] = [];
  try {
    const names = await db
      .prepare(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`)
      .all<{ table_name: string }>();
    for (const { table_name: name } of names) {
      const rows = await db.prepare(`SELECT * FROM "${name}"`).all<Record<string, unknown>>();
      tables.push({ name, rows });
    }
  } finally {
    await db.close();
  }
  createLegacyFile(path);
  const file = new DatabaseSync(path);
  try {
    file.exec('PRAGMA foreign_keys = OFF');
    for (const { name, rows } of tables) {
      for (const row of rows) {
        // A file written before account deletion has no `deleted_at` on its accounts either; one written before the
        // provider's fee has no fee on its groups or settlements.
        const columns = Object.keys(row).filter(
          column =>
            column !== 'seq' &&
            !(name === 'accounts' && column === 'deleted_at') &&
            !(name === 'groups' && column === 'fee_borne_by') &&
            !(name === 'settlements' && (column === 'fee_amount' || column === 'fee_borne_by')),
        );
        file
          .prepare(
            `INSERT INTO "${name}" (${columns.map(column => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
          )
          .run(...columns.map(column => (row[column] ?? null) as string | number | null));
      }
    }
    writeFileBeforeCategories(file);
  } finally {
    file.close();
  }
}

/**
 * Rebuilds the tables of a file written before categories and budgets, as they were: no category on expenses and
 * recurring expenses, no budget kind or budget tables among the notices. Its rows are kept as they are.
 */
function writeFileBeforeCategories(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('PRAGMA legacy_alter_table = ON');
  db.exec('ALTER TABLE expenses RENAME TO expenses_now');
  db.exec(`CREATE TABLE expenses (
    id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups (id), description TEXT NOT NULL,
    amount INTEGER NOT NULL, spent_on TEXT NOT NULL, paid_by TEXT NOT NULL REFERENCES accounts (id),
    version INTEGER NOT NULL DEFAULT 1,
    split_kind TEXT NOT NULL DEFAULT 'equal' CHECK (split_kind IN ('equal', 'exact', 'shares')),
    original_currency TEXT, original_amount INTEGER, rate TEXT, recurring_id TEXT, recurring_day TEXT,
    created_at TEXT NOT NULL)`);
  db.exec(`INSERT INTO expenses (id, group_id, description, amount, spent_on, paid_by, version, split_kind,
      original_currency, original_amount, rate, recurring_id, recurring_day, created_at)
    SELECT id, group_id, description, amount, spent_on, paid_by, version, split_kind,
      original_currency, original_amount, rate, recurring_id, recurring_day, created_at FROM expenses_now`);
  db.exec('DROP TABLE expenses_now');

  db.exec('ALTER TABLE recurring RENAME TO recurring_now');
  db.exec(`CREATE TABLE recurring (
    id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups (id), paid_by TEXT NOT NULL REFERENCES accounts (id),
    description TEXT NOT NULL, amount INTEGER NOT NULL, starts_on TEXT NOT NULL, next_on TEXT NOT NULL,
    split_kind TEXT NOT NULL CHECK (split_kind IN ('equal', 'exact', 'shares')), created_at TEXT NOT NULL)`);
  db.exec(`INSERT INTO recurring (id, group_id, paid_by, description, amount, starts_on, next_on, split_kind, created_at)
    SELECT id, group_id, paid_by, description, amount, starts_on, next_on, split_kind, created_at FROM recurring_now`);
  db.exec('DROP TABLE recurring_now');

  db.exec('ALTER TABLE notices RENAME TO notices_now');
  db.exec(`CREATE TABLE notices (
    id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL REFERENCES accounts (id),
    kind TEXT NOT NULL CHECK (kind IN ('expense', 'reminder')), group_id TEXT NOT NULL REFERENCES groups (id),
    expense_id TEXT, amount INTEGER NOT NULL, created_at TEXT NOT NULL,
    CHECK ((kind = 'expense') = (expense_id IS NOT NULL)), UNIQUE (kind, expense_id, recipient_id))`);
  db.exec(`INSERT INTO notices (id, recipient_id, kind, group_id, expense_id, amount, created_at)
    SELECT id, recipient_id, kind, group_id, expense_id, amount, created_at FROM notices_now`);
  db.exec('DROP TABLE notices_now');

  db.exec('DROP TABLE budget_months_passed');
  db.exec('DROP TABLE budgets');
  db.exec('PRAGMA legacy_alter_table = OFF');
  db.exec('PRAGMA foreign_keys = ON');
}
