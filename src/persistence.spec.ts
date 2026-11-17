import { spawn, type ChildProcess } from 'node:child_process';
import type { Application } from './app';
import { send, signedUpAccount, startApplication, testDirectory, type TestDirectory } from './test-helpers';

/** Starts `src/server.ts` as its own process on the database at `databasePath`, answering its base URL. */
function startServerProcess(databasePath: string): Promise<{ child: ChildProcess; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: { ...process.env, NODE_OPTIONS: '', PORT: '0', DATABASE_PATH: databasePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const listening = /listening on (http:\/\/127\.0\.0\.1:\d+)\/v1/.exec(output);
      if (listening) resolve({ child, baseUrl: listening[1] });
    });
    child.stderr?.on('data', (chunk: Buffer) => (errors += chunk.toString()));
    child.on('exit', code => reject(new Error(`the server exited with ${code}: ${errors}`)));
  });
}

async function call(baseUrl: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}/v1${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

describe('what the application knows, kept across restarts', () => {
  let directory: TestDirectory;

  beforeEach(() => {
    directory = testDirectory();
  });

  afterEach(() => {
    directory.remove();
  });

  it('finds the accounts and sessions of an earlier application on the same file', async () => {
    const first: Application = await startApplication(directory.databasePath);
    const ana = await signedUpAccount(first, { email: 'ana@example.org', name: 'Ana' });
    await first.stop();

    const second = await startApplication(directory.databasePath);
    const login = await send(second, 'POST', '/accounts/login', {
      body: { email: 'ana@example.org', password: 'correct horse' },
    });
    expect(login.status).toBe(200);
    const me = await send(second, 'GET', '/accounts/me', { token: ana.token });
    expect(me.body).toEqual({ id: ana.id, email: 'ana@example.org', name: 'Ana' });
    await second.stop();
  });

  it('keeps the groups and their members across restarts', async () => {
    const first = await startApplication(directory.databasePath);
    const ana = await signedUpAccount(first, { email: 'ana@example.org' });
    const created = await send(first, 'POST', '/groups', {
      token: ana.token,
      body: { name: 'Flat', currency: 'EUR' },
    });
    await first.stop();

    const second = await startApplication(directory.databasePath);
    const id = (created.body as { id: string }).id;
    const group = await send(second, 'GET', `/groups/${id}`, { token: ana.token });
    expect(group.body).toEqual({ id, name: 'Flat', currency: 'EUR', ownerId: ana.id });
    const mine = await send(second, 'GET', '/groups/mine', { token: ana.token });
    expect(mine.body).toEqual([{ id, name: 'Flat', currency: 'EUR', ownerId: ana.id }]);
    await second.stop();
  });

  it('shares the file between applications running at the same time', async () => {
    const first = await startApplication(directory.databasePath);
    const second = await startApplication(directory.databasePath);
    await signedUpAccount(first, { email: 'ana@example.org' });
    const login = await send(second, 'POST', '/accounts/login', {
      body: { email: 'ana@example.org', password: 'correct horse' },
    });
    expect(login.status).toBe(200);
    await first.stop();
    await second.stop();
  });

  it('keeps what was answered when the server is killed without warning', async () => {
    const killed = await startServerProcess(directory.databasePath);
    const signUp = await call(killed.baseUrl, '/accounts', {
      method: 'POST',
      body: JSON.stringify({ email: 'ana@example.org', password: 'correct horse', name: 'Ana' }),
    });
    expect(signUp.status).toBe(201);
    const exited = new Promise(resolve => killed.child.once('exit', resolve));
    killed.child.kill('SIGKILL');
    await exited;

    const restarted = await startServerProcess(directory.databasePath);
    try {
      const login = await call(restarted.baseUrl, '/accounts/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'ana@example.org', password: 'correct horse' }),
      });
      expect(login.status).toBe(200);
    } finally {
      restarted.child.kill('SIGKILL');
    }
  }, 30000);
});
