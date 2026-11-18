import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Application } from './app';
import { hashPassword } from './credentials';
import { openDatabase, type Queryable } from './database';
import { openLegacyFile } from './legacy-sqlite';
import { ada, call, makeDatabase, Reachable, startApplication, temporaryDatabase } from './test-support';

const SECRET = 'whsec_database_test';

/** The server of `src/server.ts` as a process of its own, so that a kill stops it as a crash would. */
async function startServerProcess(databaseUrl: string): Promise<{ app: Reachable; kill(): Promise<void> }> {
  // Node runs the server itself, with tsx as its loader, so that the kill reaches the server.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, PORT: '0', DATABASE_URL: databaseUrl, DATABASE_PATH: '', API_PREFIX: 'v1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const address = await new Promise<string>((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /listening on (http:\/\/\S+)\/v1/.exec(output);
      if (match) resolve(match[1]);
    });
    child.once('exit', code => reject(new Error(`the server exited with ${code} before it listened`)));
  });
  return {
    app: { address, apiPrefix: 'v1' },
    kill: () =>
      new Promise<void>(resolve => {
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
      }),
  };
}

describe('the database', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  /** The SQLite file Tally kept before, which a server moves into the database when it starts on an empty one. */
  let legacyDirectory: string;
  let legacy: string;
  const apps: Application[] = [];

  beforeEach(() => {
    database = temporaryDatabase();
    legacyDirectory = mkdtempSync(join(tmpdir(), 'tally-legacy-'));
    legacy = join(legacyDirectory, 'tally.db');
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.stop();
    await database.remove();
    rmSync(legacyDirectory, { recursive: true, force: true });
  });

  async function start(services: { providerWebhookSecret?: string } = {}): Promise<Application> {
    const app = await startApplication(database.url, { databasePath: legacy, ...services });
    apps.push(app);
    return app;
  }

  it('prepares an empty database and serves at once, with no file of the old kind to move', async () => {
    const app = await start();
    expect((await call(app, 'POST', '/accounts', { body: ada })).status).toBe(201);
    expect((await call(app, 'POST', '/accounts/login', { body: ada })).status).toBe(200);
    expect(existsSync(legacy)).toBe(false);
  });

  it('keeps accounts and sessions across a restart on the same database', async () => {
    const first = await start();
    await call(first, 'POST', '/accounts', { body: ada });
    const { token } = (await call(first, 'POST', '/accounts/login', { body: ada })).body;
    await first.stop();
    apps.pop();

    const second = await start();
    expect((await call(second, 'GET', '/accounts/me', { token })).status).toBe(200);
    expect((await call(second, 'POST', '/accounts/login', { body: ada })).status).toBe(200);
  });

  it('keeps what was committed when the server is killed, and a restarted server finds it', async () => {
    await makeDatabase(database.url);
    const server = await startServerProcess(database.url);
    await call(server.app, 'POST', '/accounts', { body: ada });
    const { token } = (await call(server.app, 'POST', '/accounts/login', { body: ada })).body;
    await server.kill();

    const restarted = await startServerProcess(database.url);
    try {
      expect((await call(restarted.app, 'GET', '/accounts/me', { token })).status).toBe(200);
      expect((await call(restarted.app, 'POST', '/accounts/login', { body: ada })).status).toBe(200);
    } finally {
      await restarted.kill();
    }
  });

  it('keeps the audit entry of a change answered as done, when the server is killed right after it', async () => {
    await makeDatabase(database.url);
    const server = await startServerProcess(database.url);
    const { id: adaId } = (await call(server.app, 'POST', '/accounts', { body: ada })).body;
    const { token } = (await call(server.app, 'POST', '/accounts/login', { body: ada })).body;
    const groupId = (await call(server.app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token }))
      .body.id;
    const answer = await call(server.app, 'POST', `/groups/${groupId}/expenses`, {
      body: { description: 'Groceries', amount: 1000, date: '2026-11-01', splitBetween: [adaId] },
      token,
    });
    expect(answer.status).toBe(201);
    await server.kill();

    const restarted = await startServerProcess(database.url);
    try {
      expect((await call(restarted.app, 'GET', `/groups/${groupId}/audit`, { token })).body).toEqual([
        {
          id: expect.any(String),
          at: expect.any(String),
          by: adaId,
          action: 'expense-recorded',
          subjectId: answer.body.id,
          amount: 1000,
        },
      ]);
    } finally {
      await restarted.kill();
    }
  });

  it('is shared by several servers on the same database at once', async () => {
    const first = await start();
    const second = await start();
    expect((await call(first, 'POST', '/accounts', { body: ada })).status).toBe(201);
    expect((await call(second, 'POST', '/accounts/login', { body: ada })).status).toBe(200);
  });

  it('lets only one of two simultaneous sign-ups of one email succeed', async () => {
    const first = await start();
    const second = await start();
    const answers = await Promise.all([
      call(first, 'POST', '/accounts', { body: ada }),
      call(second, 'POST', '/accounts', { body: ada }),
    ]);
    expect(answers.map(answer => answer.status).sort()).toEqual([201, 409]);
  });

  it('runs a write transaction whole when it completes, and not at all when it throws', async () => {
    await makeDatabase(database.url);
    const db = await openDatabase(database.url);
    const insert = (target: Queryable, id: string) =>
      target.run('INSERT INTO accounts (id, email, name, password_hash) VALUES (?, ?, ?, ?)', [
        id,
        `${id}@example.com`,
        id,
        'x',
      ]);
    const count = async () => (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM accounts'))?.n;
    try {
      await db.transaction(async tx => {
        await insert(tx, 'first');
        await insert(tx, 'second');
      });
      await expect(
        db.transaction(async tx => {
          await insert(tx, 'third');
          throw new Error('the work fails');
        }),
      ).rejects.toThrow('the work fails');
      expect(await count()).toBe(2);
    } finally {
      await db.close();
    }
  });

  it('moves a file Tally kept into an empty database, and serves everything it held', async () => {
    const file = openLegacyFile(legacy);
    try {
      const graceHash = await hashPassword('grace-password-1');
      file.exec(`
        INSERT INTO accounts (id, email, name, password_hash) VALUES
          ('ada', 'ada@example.com', 'Ada Lovelace', '${await hashPassword(ada.password)}'),
          ('grace', 'grace@example.com', 'Grace Hopper', '${graceHash}');
        INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES
          ('g1', 'The flat', 'EUR', 'ada', '2026-11-01T00:00:00.000Z');
        INSERT INTO group_members (group_id, account_id, joined_at, joined_order, left_at, balance_offset) VALUES
          ('g1', 'ada', '2026-11-01T00:00:00.000Z', 1, NULL, 0),
          ('g1', 'grace', '2026-11-01T01:00:00.000Z', 2, NULL, 0);
        INSERT INTO expenses (id, group_id, description, amount, date, paid_by, created_at, version, split_kind, category) VALUES
          ('e1', 'g1', 'Groceries', 1000, '2026-11-02', 'ada', '2026-11-02T10:00:00.000Z', 1, 'equal', 'groceries');
        INSERT INTO expense_shares (expense_id, position, account_id, amount) VALUES
          ('e1', 0, 'ada', 500), ('e1', 1, 'grace', 500);
        INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, provider_id, pay_url, created_at) VALUES
          ('s1', 'g1', 'grace', 'ada', 200, 'cash', 'paid', NULL, NULL, '2026-11-03T10:00:00.000Z'),
          ('s2', 'g1', 'grace', 'ada', 100, 'provider', 'pending', 'pay_1', 'https://pay.example/pay_1', '2026-11-04T10:00:00.000Z');
        INSERT INTO settlement_history (settlement_id, status, at) VALUES
          ('s1', 'paid', '2026-11-03T10:00:00.000Z'),
          ('s2', 'pending', '2026-11-04T10:00:00.000Z');
        INSERT INTO notices (id, account_id, kind, group_id, expense_id, category, month, budget, amount, created_at) VALUES
          ('n1', 'grace', 'expense', 'g1', 'e1', NULL, NULL, NULL, 500, '2026-11-02T10:00:00.000Z');
        INSERT INTO budgets (group_id, category, amount) VALUES ('g1', 'food', 5000);
        INSERT INTO audit_entries (id, group_id, at, account_id, action, subject_id, amount) VALUES
          ('au1', 'g1', '2026-11-02T10:00:00.000Z', 'ada', 'expense-recorded', 'e1', 1000),
          ('au2', 'g1', '2026-11-03T10:00:00.000Z', 'ada', 'settlement-paid', 's1', 200);
        INSERT INTO payout_accounts (account_id, provider_account_id, set_at) VALUES
          ('ada', 'acct_ada', '2026-11-01T00:00:00.000Z');
        INSERT INTO templates (id, group_id, name, name_key, split_kind, created_by, created_at) VALUES
          ('tp1', 'g1', 'Flat split', 'flat split', 'equal', 'ada', '2026-11-01T00:00:00.000Z');
        INSERT INTO template_shares (template_id, position, account_id, value) VALUES
          ('tp1', 0, 'ada', NULL), ('tp1', 1, 'grace', NULL);
        INSERT INTO recurring (id, group_id, paid_by, description, amount, starts_on, next_on, split_kind, created_at, category) VALUES
          ('rc1', 'g1', 'ada', 'Rent', 90000, '2026-11-01', '2026-12-01', 'equal', '2026-11-01T00:00:00.000Z', 'rent');
        INSERT INTO recurring_shares (recurring_id, position, account_id, value) VALUES
          ('rc1', 0, 'ada', NULL), ('rc1', 1, 'grace', NULL);
        INSERT INTO invitations (id, group_id, created_by, created_at) VALUES
          ('inv1', 'g1', 'ada', '2026-11-01T00:00:00.000Z');
      `);
    } finally {
      file.close();
    }

    const app = await start({ providerWebhookSecret: SECRET });
    const { token: adaToken } = (await call(app, 'POST', '/accounts/login', { body: ada })).body;
    const { token: graceToken } = (
      await call(app, 'POST', '/accounts/login', { body: { email: 'grace@example.com', password: 'grace-password-1' } })
    ).body;
    expect(adaToken).toEqual(expect.any(String));
    expect(graceToken).toEqual(expect.any(String));

    const balances = () => call(app, 'GET', '/groups/g1/balances', { token: adaToken }).then(answer => answer.body);
    expect(await balances()).toEqual([
      { memberId: 'ada', balance: 300 },
      { memberId: 'grace', balance: -300 },
    ]);
    expect((await call(app, 'GET', '/expenses/e1', { token: graceToken })).body.shares).toEqual([
      { memberId: 'ada', amount: 500 },
      { memberId: 'grace', amount: 500 },
    ]);
    expect((await call(app, 'GET', '/groups/g1/templates', { token: adaToken })).body).toEqual([
      { id: 'tp1', groupId: 'g1', name: 'Flat split', splitBetween: ['ada', 'grace'] },
    ]);
    expect((await call(app, 'GET', '/recurring/rc1', { token: adaToken })).body).toMatchObject({ next: '2026-12-01' });
    expect((await call(app, 'GET', '/invitations/inv1', { token: graceToken })).body).toEqual({
      id: 'inv1',
      groupId: 'g1',
      groupName: 'The flat',
      invitedBy: 'ada',
    });
    expect((await call(app, 'GET', '/notices', { token: graceToken })).body).toMatchObject([
      { id: 'n1', kind: 'expense', expenseId: 'e1', amount: 500 },
    ]);
    expect((await call(app, 'GET', '/groups/g1/budgets', { token: adaToken })).body).toEqual([
      { category: 'food', amount: 5000, spent: 0 },
    ]);

    // The payment that waited at the provider lands when its webhook comes, and counts once, however often it comes.
    const raw = JSON.stringify({
      id: 'evt_1',
      paymentId: 'pay_1',
      status: 'succeeded',
      at: '2026-11-05T10:00:00.000Z',
    });
    const signature = createHmac('sha256', SECRET).update(raw).digest('hex');
    const sendWebhook = () =>
      call(app, 'POST', '/provider/webhooks', { raw, headers: { 'Provider-Signature': signature } });
    expect((await sendWebhook()).status).toBe(204);
    expect((await sendWebhook()).status).toBe(204);
    expect(await balances()).toEqual([
      { memberId: 'ada', balance: 200 },
      { memberId: 'grace', balance: -200 },
    ]);
    const paid = (await call(app, 'GET', '/settlements/s2', { token: graceToken })).body;
    expect(paid).toMatchObject({ status: 'paid', payUrl: 'https://pay.example/pay_1' });
    expect(paid.history.map((entry: { status: string }) => entry.status)).toEqual(['pending', 'paid']);
    const audit = (await call(app, 'GET', '/groups/g1/audit', { token: adaToken })).body;
    expect(audit.filter((entry: { subjectId: string }) => entry.subjectId === 's2')).toEqual([
      expect.objectContaining({ action: 'settlement-paid', by: 'grace', amount: 100 }),
    ]);
  });

  it('moves a file at an older version, migrating it first, and serves its accounts', async () => {
    const file = new DatabaseSync(legacy);
    try {
      file.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          name TEXT NOT NULL,
          password_hash TEXT NOT NULL
        );
        CREATE UNIQUE INDEX accounts_email ON accounts (email);
        CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts (id), created_at TEXT NOT NULL);
        CREATE TABLE operations (id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts (id), status TEXT NOT NULL, result TEXT, error_type TEXT, error_message TEXT, created_at TEXT NOT NULL);
        PRAGMA user_version = 1;
      `);
      file
        .prepare('INSERT INTO accounts (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
        .run('ada', ada.email, ada.name, await hashPassword(ada.password));
    } finally {
      file.close();
    }

    const app = await start();
    expect((await call(app, 'POST', '/accounts/login', { body: ada })).status).toBe(200);
  });

  it('does not read the file again once it is moved, and does not move it into a database that holds Tally already', async () => {
    const app = await start();
    await call(app, 'POST', '/accounts', { body: { ...ada, email: 'grace@example.com', name: 'Grace Hopper' } });
    await app.stop();
    apps.pop();

    // A file that holds another account is not moved into the database, which holds Tally's state already.
    const file = openLegacyFile(legacy);
    file.exec(`INSERT INTO accounts (id, email, name, password_hash) VALUES ('ada', 'ada@example.com', 'Ada', 'x')`);
    file.close();
    const again = await start();
    expect((await call(again, 'POST', '/accounts/login', { body: ada })).status).toBe(401);
    expect(
      (await call(again, 'POST', '/accounts/login', { body: { email: 'grace@example.com', password: ada.password } }))
        .status,
    ).toBe(200);

    // Once moved, the file is not read again: a file that is no longer a database does not stop the server.
    await again.stop();
    apps.pop();
    writeFileSync(legacy, 'not a database');
    const restarted = await start();
    expect((await call(restarted, 'POST', '/accounts', { body: { ...ada, email: 'linus@example.com' } })).status).toBe(
      201,
    );
  });

  it('leaves the database empty when the file cannot be read, and moves it on the next start', async () => {
    writeFileSync(legacy, 'not a database');
    await expect(start()).rejects.toThrow();

    rmSync(legacy);
    const file = openLegacyFile(legacy);
    file.exec(
      `INSERT INTO accounts (id, email, name, password_hash) VALUES ('ada', 'ada@example.com', 'Ada', '${await hashPassword(ada.password)}')`,
    );
    file.close();
    const app = await start();
    expect((await call(app, 'POST', '/accounts/login', { body: ada })).status).toBe(200);
  });
});
