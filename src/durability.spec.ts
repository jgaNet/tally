import { createApplication } from './app';
import { openDatabase } from './database';
import { exited, send, signedUpAccount, startServerProcess, temporaryDatabaseUrl, validSignup } from './test-support';

describe('what is kept', () => {
  it('keeps accounts, and their tokens, when the application stops and starts again on the same database', async () => {
    const databaseUrl = await temporaryDatabaseUrl();
    const first = await createApplication({ databaseUrl });
    const { id, token } = await signedUpAccount(first);
    await first.stop();

    const second = await createApplication({ databaseUrl });
    const me = await send(second, 'GET', '/accounts/me', { token });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(id);
    const login = await send(second, 'POST', '/accounts/login', {
      payload: { email: validSignup.email, password: validSignup.password },
    });
    expect(login.statusCode).toBe(200);
    await second.stop();
  });

  it('is shared by several applications on the same database at the same time', async () => {
    const databaseUrl = await temporaryDatabaseUrl();
    // Both start together; each brings the schema up to date under the database's write lock.
    const [a, b] = await Promise.all([createApplication({ databaseUrl }), createApplication({ databaseUrl })]);

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
    const databaseUrl = await temporaryDatabaseUrl();
    const first = await startServerProcess(databaseUrl);
    const created = await fetch(`${first.base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validSignup),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;

    first.child.kill('SIGKILL');
    await exited(first.child);

    const second = await startServerProcess(databaseUrl);
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

describe('the database', () => {
  it('is several connections to one PostgreSQL database: a write by one is read by the other', async () => {
    const databaseUrl = await temporaryDatabaseUrl();
    const writer = await openDatabase(databaseUrl);
    const reader = await openDatabase(databaseUrl);
    try {
      await writer.execute(
        `INSERT INTO accounts (id, email, email_key, name, password_salt, password_hash, created_at)
         VALUES ('a1', 'x', 'x', 'X', 's', 'h', '2026-01-01T00:00:00.000Z')`,
      );
      expect(await reader.row('SELECT id FROM accounts WHERE id = ?', ['a1'])).toEqual({ id: 'a1' });
    } finally {
      await writer.close();
      await reader.close();
    }
  });

  it('is brought up to date once, and opening it again changes nothing', async () => {
    const databaseUrl = await temporaryDatabaseUrl();
    await (await openDatabase(databaseUrl)).close();
    const again = await openDatabase(databaseUrl);
    try {
      expect(await again.row('SELECT version FROM tally_schema')).toEqual({ version: 10 });
    } finally {
      await again.close();
    }
  });
});
