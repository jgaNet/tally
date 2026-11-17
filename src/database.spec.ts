import { spawn } from 'node:child_process';
import { Application } from './app';
import { openDatabase } from './database';
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
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    } finally {
      db.close();
    }
  });
});
