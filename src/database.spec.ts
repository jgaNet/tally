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

  it('opens an existing file without changing its schema again', () => {
    openDatabase(database.path).close();
    const db = openDatabase(database.path);
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 });
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
      before.exec('ALTER TABLE expenses DROP COLUMN split_kind');
      before.exec('ALTER TABLE group_members DROP COLUMN joined_order');
      before.exec('ALTER TABLE group_members DROP COLUMN left_at');
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
      before.exec('ALTER TABLE group_members DROP COLUMN joined_order');
      before.exec('ALTER TABLE group_members DROP COLUMN left_at');
      before.exec('PRAGMA user_version = 6');
    } finally {
      before.close();
    }

    const second = await start();
    const members = (await call(second, 'GET', `/groups/${groupId}/members`, { token })).body;
    expect(members.map((member: { memberId: string }) => member.memberId)).toEqual([adaId, graceId]);
    expect(members[1].role).toBe('member');
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
});
