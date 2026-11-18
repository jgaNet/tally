import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createApplication } from './app';
import { openDatabase } from './database';
import { send, signedUpAccount, temporaryDatabasePath, validSignup } from './test-support';

/** A free port on the loopback interface. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** Starts `src/server.ts` as its own process, on `databasePath`, and waits until it listens. */
async function startServerProcess(databasePath: string): Promise<{ child: ChildProcess; base: string }> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: databasePath, API_PREFIX: 'v1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}/v1`;
  await new Promise<void>((resolve, reject) => {
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('listening on')) resolve();
    });
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.once('exit', code => reject(new Error(`server exited (${code}) before listening: ${output}`)));
  });
  return { child, base };
}

const exited = (child: ChildProcess) =>
  new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', () => resolve());
  });

describe('what is kept', () => {
  it('keeps accounts, and their tokens, when the application stops and starts again on the same file', async () => {
    const databasePath = temporaryDatabasePath();
    const first = await createApplication({ databasePath });
    const { id, token } = await signedUpAccount(first);
    await first.stop();

    const second = await createApplication({ databasePath });
    const me = await send(second, 'GET', '/accounts/me', { token });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(id);
    const login = await send(second, 'POST', '/accounts/login', {
      payload: { email: validSignup.email, password: validSignup.password },
    });
    expect(login.statusCode).toBe(200);
    await second.stop();
  });

  it('is shared by several applications on the same file at the same time', async () => {
    const databasePath = temporaryDatabasePath();
    // Both start together; each brings the schema up to date under the file's write lock.
    const [a, b] = await Promise.all([createApplication({ databasePath }), createApplication({ databasePath })]);

    const created = await send(a, 'POST', '/accounts', { payload: validSignup });
    expect(created.statusCode).toBe(201);

    const seenByB = await send(b, 'POST', '/accounts/login', {
      payload: { email: validSignup.email, password: validSignup.password },
    });
    expect(seenByB.statusCode).toBe(200);

    const duplicate = await send(b, 'POST', '/accounts', {
      payload: { ...validSignup, email: validSignup.email.toUpperCase() },
    });
    expect(duplicate.statusCode).toBe(409);

    await a.stop();
    await b.stop();
  });

  it('keeps what was written when a server process is killed without warning', async () => {
    const databasePath = temporaryDatabasePath();
    const first = await startServerProcess(databasePath);
    const created = await fetch(`${first.base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validSignup),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;

    first.child.kill('SIGKILL');
    await exited(first.child);

    const second = await startServerProcess(databasePath);
    try {
      const login = await fetch(`${second.base}/accounts/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: validSignup.email, password: validSignup.password }),
      });
      expect(login.status).toBe(200);
      const { token } = (await login.json()) as { token: string };
      const me = await fetch(`${second.base}/accounts/me`, { headers: { authorization: `Bearer ${token}` } });
      expect(((await me.json()) as { id: string }).id).toBe(id);
    } finally {
      second.child.kill('SIGTERM');
      await exited(second.child);
    }
  });
});

describe('the database file', () => {
  it('is opened in WAL mode, so that several connections can use it', () => {
    const databasePath = temporaryDatabasePath();
    const writer = openDatabase(databasePath);
    const reader = openDatabase(databasePath);
    expect(writer.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    writer.close();
    reader.close();
  });

  it('is brought up to date once, and opening it again changes nothing', () => {
    const databasePath = temporaryDatabasePath();
    openDatabase(databasePath).close();
    const again = openDatabase(databasePath);
    expect(again.prepare('PRAGMA user_version').get()?.user_version).toBe(19);
    again.close();
  });
});
