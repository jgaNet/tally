import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Application } from './app';
import { inTransaction, openDatabase } from './database';
import { ada, call, Reachable, startApplication, temporaryDatabase } from './test-support';

/** The server of `src/server.ts` as a process of its own, so that a kill stops it as a crash would. */
async function startServerProcess(databasePath: string): Promise<{ app: Reachable; kill(): Promise<void> }> {
  // Node runs the server itself, with tsx as its loader, so that the kill reaches the server.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, PORT: '0', DATABASE_PATH: databasePath, API_PREFIX: 'v1' },
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
  const apps: Application[] = [];

  beforeEach(() => {
    database = temporaryDatabase();
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.stop();
    database.remove();
  });

  async function start(): Promise<Application> {
    const app = await startApplication(database.path);
    apps.push(app);
    return app;
  }

  it('keeps accounts and sessions across a restart on the same file', async () => {
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
    const server = await startServerProcess(database.path);
    await call(server.app, 'POST', '/accounts', { body: ada });
    const { token } = (await call(server.app, 'POST', '/accounts/login', { body: ada })).body;
    await server.kill();

    const restarted = await startServerProcess(database.path);
    try {
      expect((await call(restarted.app, 'GET', '/accounts/me', { token })).status).toBe(200);
      expect((await call(restarted.app, 'POST', '/accounts/login', { body: ada })).status).toBe(200);
    } finally {
      await restarted.kill();
    }
  });

  it('is shared by several servers on the same file at once', async () => {
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

  it('takes reminders on a file at version 13, and keeps the notices it had in order', () => {
    openDatabase(database.path).close();
    const before = new DatabaseSync(database.path);
    try {
      before.exec('ALTER TABLE group_members DROP COLUMN balance_offset');
      before.exec(`
        DROP TABLE debt_notes;
        DROP TABLE notices;
        CREATE TABLE notices (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts (id),
          kind TEXT NOT NULL CHECK (kind IN ('expense')),
          group_id TEXT NOT NULL REFERENCES groups (id),
          expense_id TEXT NOT NULL,
          amount INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX notices_expense_account ON notices (expense_id, account_id);
        CREATE INDEX notices_account ON notices (account_id, created_at);
        INSERT INTO accounts (id, email, name, password_hash) VALUES ('a', 'a@example.com', 'A', 'x');
        INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES ('g', 'G', 'EUR', 'a', '2026-11-01T00:00:00.000Z');
        INSERT INTO notices (id, account_id, kind, group_id, expense_id, amount, created_at)
          VALUES ('n1', 'a', 'expense', 'g', 'e1', 5, '2026-11-02T00:00:00.000Z'),
                 ('n2', 'a', 'expense', 'g', 'e2', 6, '2026-11-02T00:00:00.000Z');
        DROP TABLE settlement_history;
        ALTER TABLE payment_decisions DROP COLUMN decided_at;
        ALTER TABLE expenses DROP COLUMN original_rate;
        ALTER TABLE expenses DROP COLUMN original_amount;
        ALTER TABLE expenses DROP COLUMN original_currency;
        PRAGMA user_version = 13;
      `);
    } finally {
      before.close();
    }

    const db = openDatabase(database.path);
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 17 });
      expect(db.prepare('SELECT id FROM notices ORDER BY rowid').all()).toEqual([{ id: 'n1' }, { id: 'n2' }]);
      db.prepare(
        "INSERT INTO notices (id, account_id, kind, group_id, expense_id, amount, created_at) VALUES ('r', 'a', 'reminder', 'g', NULL, 2500, '2026-11-09T00:00:00.000Z')",
      ).run();
      expect(db.prepare("SELECT COUNT(*) AS n FROM notices WHERE kind = 'reminder'").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it('opens an existing file without changing its schema again', () => {
    openDatabase(database.path).close();
    const db = openDatabase(database.path);
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 17 });
    } finally {
      db.close();
    }
  });

  it('adds the notices to a file at version 12, with none in it, and refuses a second one per member', () => {
    openDatabase(database.path).close();
    const before = new DatabaseSync(database.path);
    try {
      before.exec('ALTER TABLE group_members DROP COLUMN balance_offset');
      before.exec('DROP TABLE debt_notes');
      before.exec('DROP TABLE notices');
      before.exec('DROP TABLE settlement_history');
      before.exec('ALTER TABLE payment_decisions DROP COLUMN decided_at');
      before.exec('ALTER TABLE expenses DROP COLUMN original_rate');
      before.exec('ALTER TABLE expenses DROP COLUMN original_amount');
      before.exec('ALTER TABLE expenses DROP COLUMN original_currency');
      before.exec('PRAGMA user_version = 12');
    } finally {
      before.close();
    }

    const db = openDatabase(database.path);
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 17 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM notices').get()).toEqual({ count: 0 });
      expect(() =>
        db.exec(`INSERT INTO accounts (id, email, name, password_hash) VALUES ('a', 'a@example.com', 'A', 'x');
          INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES ('g', 'G', 'EUR', 'a', '2026-11-01T00:00:00.000Z');
          INSERT INTO notices (id, account_id, kind, group_id, expense_id, amount, created_at) VALUES ('n1', 'a', 'expense', 'g', 'e', 1, '2026-11-02T00:00:00.000Z');
          INSERT INTO notices (id, account_id, kind, group_id, expense_id, amount, created_at) VALUES ('n2', 'a', 'expense', 'g', 'e', 1, '2026-11-02T00:00:00.000Z');`),
      ).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  it('reads an expense recorded before splits could be unequal as split equally', async () => {
    const first = await start();
    const { id: adaId } = (await call(first, 'POST', '/accounts', { body: ada })).body;
    const { token } = (await call(first, 'POST', '/accounts/login', { body: ada })).body;
    const groupId = (await call(first, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token })).body
      .id;
    const expenseId = (
      await call(first, 'POST', `/groups/${groupId}/expenses`, {
        body: { description: 'Groceries', amount: 1000, date: '2026-11-01', splitBetween: [adaId] },
        token,
      })
    ).body.id;
    await first.stop();
    apps.pop();

    // The file as the schema was before splits could be unequal: no column for the kind of split, version 5.
    const before = new DatabaseSync(database.path);
    try {
      before.exec('ALTER TABLE group_members DROP COLUMN balance_offset');
      before.exec('DROP TABLE payment_decisions');
      before.exec('DROP TABLE payout_accounts');
      before.exec('DROP TABLE settlements');
      before.exec('ALTER TABLE expenses DROP COLUMN split_kind');
      before.exec('ALTER TABLE group_members DROP COLUMN joined_order');
      before.exec('ALTER TABLE group_members DROP COLUMN left_at');
      before.exec('DROP TABLE debt_notes');
      before.exec('DROP TABLE notices');
      before.exec('DROP TABLE settlement_history');
      before.exec('ALTER TABLE expenses DROP COLUMN original_rate');
      before.exec('ALTER TABLE expenses DROP COLUMN original_amount');
      before.exec('ALTER TABLE expenses DROP COLUMN original_currency');
      before.exec('PRAGMA user_version = 5');
    } finally {
      before.close();
    }

    const second = await start();
    expect((await call(second, 'GET', `/expenses/${expenseId}`, { token })).body).toMatchObject({
      splitKind: 'equal',
      shares: [{ memberId: adaId, amount: 1000 }],
    });
  });

  it('keeps the members recorded before leaving existed current, in the order they joined', async () => {
    const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
    const first = await start();
    const { id: adaId } = (await call(first, 'POST', '/accounts', { body: ada })).body;
    const { token } = (await call(first, 'POST', '/accounts/login', { body: ada })).body;
    const graceId = (await call(first, 'POST', '/accounts', { body: grace })).body.id;
    const graceToken = (await call(first, 'POST', '/accounts/login', { body: grace })).body.token;
    const groupId = (await call(first, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token })).body
      .id;
    const invitation = (await call(first, 'POST', `/groups/${groupId}/invitations`, { token })).body.id;
    await call(first, 'POST', `/invitations/${invitation}/accept`, { token: graceToken });
    await first.stop();
    apps.pop();

    // The file as the schema was before a membership could end: no column for it, version 6.
    const before = new DatabaseSync(database.path);
    try {
      before.exec('ALTER TABLE group_members DROP COLUMN balance_offset');
      before.exec('DROP TABLE payment_decisions');
      before.exec('DROP TABLE payout_accounts');
      before.exec('DROP TABLE settlements');
      before.exec('ALTER TABLE group_members DROP COLUMN joined_order');
      before.exec('ALTER TABLE group_members DROP COLUMN left_at');
      before.exec('DROP TABLE debt_notes');
      before.exec('DROP TABLE notices');
      before.exec('DROP TABLE settlement_history');
      before.exec('ALTER TABLE expenses DROP COLUMN original_rate');
      before.exec('ALTER TABLE expenses DROP COLUMN original_amount');
      before.exec('ALTER TABLE expenses DROP COLUMN original_currency');
      before.exec('PRAGMA user_version = 6');
    } finally {
      before.close();
    }

    const second = await start();
    const members = (await call(second, 'GET', `/groups/${groupId}/members`, { token })).body;
    expect(members.map((member: { memberId: string }) => member.memberId)).toEqual([adaId, graceId]);
    expect(members[1].role).toBe('member');
  });

  it('keeps the expenses of a file recorded before settlements existed, and counts no settlement in them', async () => {
    const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
    const first = await start();
    const { id: adaId } = (await call(first, 'POST', '/accounts', { body: ada })).body;
    const { token } = (await call(first, 'POST', '/accounts/login', { body: ada })).body;
    const graceId = (await call(first, 'POST', '/accounts', { body: grace })).body.id;
    const graceToken = (await call(first, 'POST', '/accounts/login', { body: grace })).body.token;
    const groupId = (await call(first, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token })).body
      .id;
    const invitation = (await call(first, 'POST', `/groups/${groupId}/invitations`, { token })).body.id;
    await call(first, 'POST', `/invitations/${invitation}/accept`, { token: graceToken });
    const expenseId = (
      await call(first, 'POST', `/groups/${groupId}/expenses`, {
        body: { description: 'Groceries', amount: 1000, date: '2026-11-01', splitBetween: [adaId, graceId] },
        token,
      })
    ).body.id;
    await first.stop();
    apps.pop();

    // The file as the schema was before settlements: no table for them, version 7.
    const before = new DatabaseSync(database.path);
    try {
      before.exec('ALTER TABLE group_members DROP COLUMN balance_offset');
      before.exec('DROP TABLE payment_decisions');
      before.exec('DROP TABLE payout_accounts');
      before.exec('DROP TABLE settlements');
      before.exec('DROP TABLE debt_notes');
      before.exec('DROP TABLE notices');
      before.exec('DROP TABLE settlement_history');
      before.exec('ALTER TABLE expenses DROP COLUMN original_rate');
      before.exec('ALTER TABLE expenses DROP COLUMN original_amount');
      before.exec('ALTER TABLE expenses DROP COLUMN original_currency');
      before.exec('PRAGMA user_version = 7');
    } finally {
      before.close();
    }

    const second = await start();
    expect((await call(second, 'GET', `/expenses/${expenseId}`, { token })).body).toMatchObject({
      amount: 1000,
      shares: [
        { memberId: adaId, amount: 500 },
        { memberId: graceId, amount: 500 },
      ],
    });
    expect((await call(second, 'GET', `/groups/${groupId}/balances`, { token })).body).toEqual([
      { memberId: adaId, balance: 500 },
      { memberId: graceId, balance: -500 },
    ]);
  });

  it('keeps the cash settlements of a file recorded before settlements could go through the provider', () => {
    openDatabase(database.path).close();
    // The file as the schema was before provider settlements: the settlements table of version 8, one cash row.
    const before = new DatabaseSync(database.path);
    try {
      before.exec('ALTER TABLE group_members DROP COLUMN balance_offset');
      before.exec(`
        DROP TABLE payment_decisions;
        DROP TABLE payout_accounts;
        DROP TABLE settlements;
        CREATE TABLE settlements (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL REFERENCES groups (id),
          payer_id TEXT NOT NULL REFERENCES accounts (id),
          payee_id TEXT NOT NULL REFERENCES accounts (id),
          amount INTEGER NOT NULL CHECK (amount >= 1),
          method TEXT NOT NULL CHECK (method IN ('cash')),
          status TEXT NOT NULL CHECK (status IN ('paid')),
          created_at TEXT NOT NULL
        );
        CREATE INDEX settlements_group ON settlements (group_id);
        INSERT INTO accounts (id, email, name, password_hash) VALUES ('a', 'a@example.com', 'A', 'x'), ('b', 'b@example.com', 'B', 'x');
        INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES ('g', 'G', 'EUR', 'a', '2026-11-01T00:00:00.000Z');
        INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at)
          VALUES ('s', 'g', 'b', 'a', 300, 'cash', 'paid', '2026-11-02T00:00:00.000Z');
        DROP TABLE debt_notes;
        DROP TABLE notices;
        DROP TABLE settlement_history;
        ALTER TABLE expenses DROP COLUMN original_rate;
        ALTER TABLE expenses DROP COLUMN original_amount;
        ALTER TABLE expenses DROP COLUMN original_currency;
        PRAGMA user_version = 8;
      `);
    } finally {
      before.close();
    }

    const db = openDatabase(database.path);
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 17 });
      expect(db.prepare('SELECT id, method, status, provider_id, pay_url FROM settlements').all()).toEqual([
        { id: 's', method: 'cash', status: 'paid', provider_id: null, pay_url: null },
      ]);
      // The rebuilt table takes the provider's settlements, pending or failed, as it takes cash.
      db.exec(`INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at)
        VALUES ('p', 'g', 'b', 'a', 100, 'provider', 'pending', '2026-11-03T00:00:00.000Z')`);
      expect(() =>
        db.exec(`INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at)
          VALUES ('x', 'g', 'b', 'a', 100, 'cheque', 'paid', '2026-11-03T00:00:00.000Z')`),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('keeps the provider settlements and decisions of a file at version 10, and takes refunds', () => {
    openDatabase(database.path).close();
    // The file as the schema was at version 10: a provider settlement paid, and the decision kept for its payment.
    const before = new DatabaseSync(database.path);
    try {
      before.exec('ALTER TABLE group_members DROP COLUMN balance_offset');
      before.exec(`
        DROP TABLE payment_decisions;
        DROP TABLE payout_accounts;
        DROP TABLE settlements;
        CREATE TABLE settlements (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL REFERENCES groups (id),
          payer_id TEXT NOT NULL REFERENCES accounts (id),
          payee_id TEXT NOT NULL REFERENCES accounts (id),
          amount INTEGER NOT NULL CHECK (amount >= 1),
          method TEXT NOT NULL CHECK (method IN ('cash', 'provider')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed')),
          provider_id TEXT,
          pay_url TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX settlements_group ON settlements (group_id);
        CREATE UNIQUE INDEX settlements_provider ON settlements (provider_id) WHERE provider_id IS NOT NULL;
        CREATE TABLE payment_decisions (
          payment_id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('paid', 'failed'))
        );
        INSERT INTO accounts (id, email, name, password_hash) VALUES ('a', 'a@example.com', 'A', 'x'), ('b', 'b@example.com', 'B', 'x');
        INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES ('g', 'G', 'EUR', 'a', '2026-11-01T00:00:00.000Z');
        INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, provider_id, pay_url, created_at)
          VALUES ('s', 'g', 'b', 'a', 300, 'provider', 'paid', 'pay_9', 'https://pay.example/pay_9', '2026-11-02T00:00:00.000Z');
        INSERT INTO payment_decisions (payment_id, status) VALUES ('pay_9', 'paid');
        DROP TABLE debt_notes;
        DROP TABLE notices;
        DROP TABLE settlement_history;
        ALTER TABLE expenses DROP COLUMN original_rate;
        ALTER TABLE expenses DROP COLUMN original_amount;
        ALTER TABLE expenses DROP COLUMN original_currency;
        PRAGMA user_version = 10;
      `);
    } finally {
      before.close();
    }

    const db = openDatabase(database.path);
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 17 });
      expect(db.prepare('SELECT id, status, provider_id FROM settlements').all()).toEqual([
        { id: 's', status: 'paid', provider_id: 'pay_9' },
      ]);
      expect(db.prepare('SELECT payment_id, status FROM payment_decisions').all()).toEqual([
        { payment_id: 'pay_9', status: 'paid' },
      ]);
      // The rebuilt tables take a refund in progress, a refund made, and a refund said by the provider.
      db.exec("UPDATE settlements SET status = 'refunding' WHERE id = 's'");
      db.exec("UPDATE settlements SET status = 'refunded' WHERE id = 's'");
      db.exec("INSERT INTO payment_decisions (payment_id, status) VALUES ('pay_10', 'refunded')");
      expect(() => db.exec("UPDATE settlements SET status = 'chargeback' WHERE id = 's'")).toThrow();
      expect(() =>
        db.exec("INSERT INTO payment_decisions (payment_id, status) VALUES ('pay_11', 'pending')"),
      ).toThrow();
      // The provider's id of a payment is still given to one settlement only.
      expect(() =>
        db.exec(`INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, provider_id, created_at)
          VALUES ('t', 'g', 'b', 'a', 100, 'provider', 'pending', 'pay_9', '2026-11-03T00:00:00.000Z')`),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('takes payout accounts on a file at version 11, and keeps the accounts it had', () => {
    openDatabase(database.path).close();
    const before = new DatabaseSync(database.path);
    try {
      before.exec('ALTER TABLE group_members DROP COLUMN balance_offset');
      before.exec(`
        INSERT INTO accounts (id, email, name, password_hash) VALUES ('a', 'a@example.com', 'A', 'x');
        DROP TABLE payout_accounts;
        DROP TABLE debt_notes;
        DROP TABLE notices;
        DROP TABLE settlement_history;
        ALTER TABLE payment_decisions DROP COLUMN decided_at;
        ALTER TABLE expenses DROP COLUMN original_rate;
        ALTER TABLE expenses DROP COLUMN original_amount;
        ALTER TABLE expenses DROP COLUMN original_currency;
        PRAGMA user_version = 11;
      `);
    } finally {
      before.close();
    }

    const db = openDatabase(database.path);
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 17 });
      expect(db.prepare('SELECT id FROM accounts').all()).toEqual([{ id: 'a' }]);
      db.exec(
        "INSERT INTO payout_accounts (account_id, provider_account_id, set_at) VALUES ('a', 'acct_a', '2026-11-01T00:00:00.000Z')",
      );
      expect(db.prepare('SELECT account_id, provider_account_id FROM payout_accounts').all()).toEqual([
        { account_id: 'a', provider_account_id: 'acct_a' },
      ]);
      // A payout account belongs to an account of the database, and a member has one at most.
      expect(() =>
        db.exec(
          "INSERT INTO payout_accounts (account_id, provider_account_id, set_at) VALUES ('nobody', 'acct_n', '2026-11-01T00:00:00.000Z')",
        ),
      ).toThrow();
      expect(() =>
        db.exec(
          "INSERT INTO payout_accounts (account_id, provider_account_id, set_at) VALUES ('a', 'acct_b', '2026-11-01T00:00:00.000Z')",
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('dates the settlements of a file at version 14 by when they were recorded, and their decisions by the migration', () => {
    openDatabase(database.path).close();
    const before = new DatabaseSync(database.path);
    try {
      before.exec('ALTER TABLE group_members DROP COLUMN balance_offset');
      before.exec(`
        DROP TABLE settlement_history;
        ALTER TABLE payment_decisions DROP COLUMN decided_at;
        INSERT INTO accounts (id, email, name, password_hash) VALUES ('a', 'a@example.com', 'A', 'x'), ('b', 'b@example.com', 'B', 'x');
        INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES ('g', 'G', 'EUR', 'a', '2026-11-01T00:00:00.000Z');
        INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, provider_id, pay_url, created_at) VALUES
          ('cash', 'g', 'b', 'a', 500, 'cash', 'paid', NULL, NULL, '2026-11-02T00:00:00.000Z'),
          ('waiting', 'g', 'b', 'a', 300, 'provider', 'pending', NULL, NULL, '2026-11-03T00:00:00.000Z'),
          ('settled', 'g', 'b', 'a', 200, 'provider', 'paid', 'pay_1', 'https://pay.example/pay_1', '2026-11-04T00:00:00.000Z');
        INSERT INTO payment_decisions (payment_id, status) VALUES ('pay_1', 'paid');
        ALTER TABLE expenses DROP COLUMN original_rate;
        ALTER TABLE expenses DROP COLUMN original_amount;
        ALTER TABLE expenses DROP COLUMN original_currency;
        PRAGMA user_version = 14;
      `);
    } finally {
      before.close();
    }

    const db = openDatabase(database.path);
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 17 });
      const history = (id: string) =>
        db.prepare('SELECT status, at FROM settlement_history WHERE settlement_id = ? ORDER BY seq').all(id);
      expect(history('cash')).toEqual([{ status: 'paid', at: '2026-11-02T00:00:00.000Z' }]);
      expect(history('waiting')).toEqual([{ status: 'pending', at: '2026-11-03T00:00:00.000Z' }]);
      const settled = history('settled') as { status: string; at: string }[];
      expect(settled.map(entry => entry.status)).toEqual(['pending', 'paid']);
      expect(settled[0].at).toBe('2026-11-04T00:00:00.000Z');
      expect(settled[1].at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(
        db.prepare("SELECT decided_at IS NOT NULL AS dated FROM payment_decisions WHERE payment_id = 'pay_1'").get(),
      ).toEqual({
        dated: 1,
      });
    } finally {
      db.close();
    }
  });

  it('keeps all of a transaction that completes, and none of one that throws', () => {
    const db = openDatabase(database.path);
    try {
      db.exec('CREATE TABLE notes (text TEXT NOT NULL)');
      inTransaction(db, () => db.exec("INSERT INTO notes (text) VALUES ('kept')"));
      expect(() =>
        inTransaction(db, () => {
          db.exec("INSERT INTO notes (text) VALUES ('rolled back')");
          throw new Error('the work failed');
        }),
      ).toThrow('the work failed');
      expect(db.prepare('SELECT text FROM notes').all()).toEqual([{ text: 'kept' }]);
    } finally {
      db.close();
    }
  });

  it("reads the expenses of a file recorded before expenses could be paid in another currency as in the group's", async () => {
    const first = await start();
    const { id: adaId } = (await call(first, 'POST', '/accounts', { body: ada })).body;
    const { token } = (await call(first, 'POST', '/accounts/login', { body: ada })).body;
    const groupId = (await call(first, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token })).body
      .id;
    const expenseId = (
      await call(first, 'POST', `/groups/${groupId}/expenses`, {
        body: { description: 'Groceries', amount: 1000, date: '2026-11-01', splitBetween: [adaId] },
        token,
      })
    ).body.id;
    await first.stop();
    apps.pop();

    // The file as it was before an expense could be paid in another currency: no columns for it, one version less.
    const before = new DatabaseSync(database.path);
    try {
      const current = Number((before.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      before.exec('ALTER TABLE expenses DROP COLUMN original_rate');
      before.exec('ALTER TABLE expenses DROP COLUMN original_amount');
      before.exec('ALTER TABLE expenses DROP COLUMN original_currency');
      before.exec(`PRAGMA user_version = ${current - 1}`);
    } finally {
      before.close();
    }

    const second = await start();
    const body = (await call(second, 'GET', `/expenses/${expenseId}`, { token })).body;
    expect(body).toMatchObject({ amount: 1000, splitKind: 'equal' });
    expect(body).not.toHaveProperty('original');
  });
});
