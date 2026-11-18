import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createApplication, type Application } from './app';
import { createLegacyFile } from './legacy-file';
import { hashPassword } from './passwords';
import {
  ensureDatabase,
  send,
  signedUpAccount,
  startApplication,
  testDirectory,
  type TestDirectory,
} from './test-helpers';

const PROVIDER_SECRET = 'provider-secret';

/**
 * Starts `src/server.ts` as its own process on the database at `databaseUrl`, with the SQLite file `databasePath` when
 * given, answering its base URL.
 */
function startServerProcess(databaseUrl: string, databasePath = ''): Promise<{ child: ChildProcess; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      env: { ...process.env, NODE_OPTIONS: '', PORT: '0', DATABASE_URL: databaseUrl, DATABASE_PATH: databasePath },
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

/** Writes rows into the SQLite file at `path`, one statement and its parameters each. */
function writeLegacyRows(path: string, rows: [string, (string | number | null)[]][]): void {
  const file = new DatabaseSync(path);
  try {
    for (const [sql, params] of rows) file.prepare(sql).run(...params);
  } finally {
    file.close();
  }
}

describe('what the application knows, kept across restarts', () => {
  let directory: TestDirectory;

  beforeEach(() => {
    directory = testDirectory();
  });

  afterEach(async () => {
    await directory.remove();
  });

  it('finds the accounts and sessions of an earlier application on the same database', async () => {
    const first: Application = await startApplication(directory.databaseUrl);
    const ana = await signedUpAccount(first, { email: 'ana@example.org', name: 'Ana' });
    await first.stop();

    const second = await startApplication(directory.databaseUrl);
    const login = await send(second, 'POST', '/accounts/login', {
      body: { email: 'ana@example.org', password: 'correct horse' },
    });
    expect(login.status).toBe(200);
    const me = await send(second, 'GET', '/accounts/me', { token: ana.token });
    expect(me.body).toEqual({ id: ana.id, email: 'ana@example.org', name: 'Ana' });
    await second.stop();
  });

  it('keeps the groups and their members across restarts', async () => {
    const first = await startApplication(directory.databaseUrl);
    const ana = await signedUpAccount(first, { email: 'ana@example.org' });
    const created = await send(first, 'POST', '/groups', {
      token: ana.token,
      body: { name: 'Flat', currency: 'EUR' },
    });
    await first.stop();

    const second = await startApplication(directory.databaseUrl);
    const id = (created.body as { id: string }).id;
    const group = await send(second, 'GET', `/groups/${id}`, { token: ana.token });
    expect(group.body).toEqual({ id, name: 'Flat', currency: 'EUR', ownerId: ana.id });
    const mine = await send(second, 'GET', '/groups/mine', { token: ana.token });
    expect(mine.body).toEqual([{ id, name: 'Flat', currency: 'EUR', ownerId: ana.id }]);
    await second.stop();
  });

  it('keeps the invitations and the memberships they made across restarts', async () => {
    const first = await startApplication(directory.databaseUrl);
    const ana = await signedUpAccount(first, { email: 'ana@example.org' });
    const ben = await signedUpAccount(first, { email: 'ben@example.org' });
    const groupId = (
      (
        await send(first, 'POST', '/groups', {
          token: ana.token,
          body: { name: 'Flat', currency: 'EUR' },
        })
      ).body as { id: string }
    ).id;
    const invitationId = (
      (
        await send(first, 'POST', `/groups/${groupId}/invitations`, {
          token: ana.token,
        })
      ).body as { id: string }
    ).id;
    expect((await send(first, 'POST', `/invitations/${invitationId}/accept`, { token: ben.token })).status).toBe(204);
    await first.stop();

    const second = await startApplication(directory.databaseUrl);
    const invitation = await send(second, 'GET', `/invitations/${invitationId}`, { token: ben.token });
    expect(invitation.body).toEqual({ id: invitationId, groupId, groupName: 'Flat', invitedBy: ana.id });
    const members = await send(second, 'GET', `/groups/${groupId}/members`, { token: ana.token });
    expect(members.body).toEqual([
      { memberId: ana.id, name: 'Ana', role: 'owner', joinedAt: expect.any(String) },
      { memberId: ben.id, name: 'Ana', role: 'member', joinedAt: expect.any(String) },
    ]);
    await second.stop();
  });

  it('shares the database between applications running at the same time', async () => {
    const first = await startApplication(directory.databaseUrl);
    const second = await startApplication(directory.databaseUrl);
    await signedUpAccount(first, { email: 'ana@example.org' });
    const login = await send(second, 'POST', '/accounts/login', {
      body: { email: 'ana@example.org', password: 'correct horse' },
    });
    expect(login.status).toBe(200);
    await first.stop();
    await second.stop();
  });

  it('keeps what was answered when the server is killed without warning', async () => {
    await ensureDatabase(directory.databaseUrl);
    const killed = await startServerProcess(directory.databaseUrl);
    const signUp = await call(killed.baseUrl, '/accounts', {
      method: 'POST',
      body: JSON.stringify({ email: 'ana@example.org', password: 'correct horse', name: 'Ana' }),
    });
    expect(signUp.status).toBe(201);
    const exited = new Promise(resolve => killed.child.once('exit', resolve));
    killed.child.kill('SIGKILL');
    await exited;

    const restarted = await startServerProcess(directory.databaseUrl);
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

describe('what a file Tally kept before holds, moved to the database', () => {
  let directory: TestDirectory;

  beforeEach(() => {
    directory = testDirectory();
  });

  afterEach(async () => {
    await directory.remove();
  });

  /** A file of an earlier version: Ana, the owner of a group with Ben, who owes nothing yet. */
  async function writeEarlierFile(): Promise<void> {
    createLegacyFile(directory.legacyPath);
    const passwordHash = await hashPassword('correct horse');
    writeLegacyRows(directory.legacyPath, [
      [
        'INSERT INTO accounts (id, email, email_key, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['ana-id', 'ana@example.org', 'ana@example.org', 'Ana', passwordHash, '2026-01-01T10:00:00.000Z'],
      ],
      [
        'INSERT INTO accounts (id, email, email_key, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['ben-id', 'ben@example.org', 'ben@example.org', 'Ben', passwordHash, '2026-01-01T10:00:00.000Z'],
      ],
      [
        'INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES (?, ?, ?, ?, ?)',
        ['group-1', 'Flat', 'EUR', 'ana-id', '2026-01-01T10:00:00.000Z'],
      ],
      [
        'INSERT INTO group_members (group_id, account_id, joined_at) VALUES (?, ?, ?)',
        ['group-1', 'ana-id', '2026-01-01T10:00:00.000Z'],
      ],
      [
        'INSERT INTO group_members (group_id, account_id, joined_at) VALUES (?, ?, ?)',
        ['group-1', 'ben-id', '2026-01-01T10:01:00.000Z'],
      ],
    ]);
  }

  async function logIn(app: Application, email: string): Promise<string> {
    const login = await send(app, 'POST', '/accounts/login', { body: { email, password: 'correct horse' } });
    expect(login.status).toBe(200);
    return (login.body as { token: string }).token;
  }

  it('moves everything the file holds into an empty database, then serves it', async () => {
    await writeEarlierFile();
    const app = await startApplication(directory.databaseUrl, { databasePath: directory.legacyPath });
    const token = await logIn(app, 'ana@example.org');
    const group = await send(app, 'GET', '/groups/group-1', { token });
    expect(group.body).toEqual({ id: 'group-1', name: 'Flat', currency: 'EUR', ownerId: 'ana-id' });
    const members = await send(app, 'GET', '/groups/group-1/members', { token });
    expect(members.body).toEqual([
      { memberId: 'ana-id', name: 'Ana', role: 'owner', joinedAt: '2026-01-01T10:00:00.000Z' },
      { memberId: 'ben-id', name: 'Ben', role: 'member', joinedAt: '2026-01-01T10:01:00.000Z' },
    ]);
    await app.stop();
  });

  it('never reads the file again once the database holds Tally’s data', async () => {
    await writeEarlierFile();
    const first = await startApplication(directory.databaseUrl, { databasePath: directory.legacyPath });
    await first.stop();

    // The file is no longer a database at all: a server that read it again would not start.
    writeFileSync(directory.legacyPath, 'not a SQLite file');
    const second = await startApplication(directory.databaseUrl, { databasePath: directory.legacyPath });
    const token = await logIn(second, 'ana@example.org');
    const group = await send(second, 'GET', '/groups/group-1', { token });
    expect(group.status).toBe(200);
    await second.stop();
  });

  it('counts a payment waiting at the provider once, when its webhook says it succeeded', async () => {
    await writeEarlierFile();
    // A file of an earlier version has no history of statuses: its pending payment is backfilled from what it is now.
    writeLegacyRows(directory.legacyPath, [
      ['DROP TABLE settlement_statuses', []],
      [
        `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, provider_payment_id, pay_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'settlement-1',
          'group-1',
          'ben-id',
          'ana-id',
          500,
          'provider',
          'pending',
          'pay_legacy',
          'https://pay.example.org/pay_legacy',
          '2026-01-02T10:00:00.000Z',
        ],
      ],
    ]);
    await ensureDatabase(directory.databaseUrl);
    const app = await createApplication({
      databaseUrl: directory.databaseUrl,
      databasePath: directory.legacyPath,
      providerUrl: 'http://127.0.0.1:9',
      providerWebhookSecret: PROVIDER_SECRET,
    });
    try {
      await app.start(0);
      await checkPaymentCountsOnce(app);
    } finally {
      await app.stop();
    }
  });

  /** The provider's webhook, twice, moves the pending payment to paid once: the balances count it once. */
  async function checkPaymentCountsOnce(app: Application): Promise<void> {
    const benToken = await logIn(app, 'ben@example.org');
    const balancesOf = async () =>
      (await send(app, 'GET', '/groups/group-1/balances', { token: benToken })).body as {
        memberId: string;
        balance: number;
      }[];
    expect(await balancesOf()).toEqual([
      { memberId: 'ana-id', balance: 0 },
      { memberId: 'ben-id', balance: 0 },
    ]);

    const deliver = async () => {
      const body = JSON.stringify({
        id: 'evt_legacy_1',
        paymentId: 'pay_legacy',
        status: 'succeeded',
        at: new Date().toISOString(),
      });
      const signature = createHmac('sha256', PROVIDER_SECRET).update(body).digest('hex');
      const response = await fetch(`${app.address}/${app.apiPrefix}/provider/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'provider-signature': signature },
        body,
      });
      return response.status;
    };
    expect(await deliver()).toBe(204);
    expect(await deliver()).toBe(204);

    expect(await balancesOf()).toEqual([
      { memberId: 'ana-id', balance: -500 },
      { memberId: 'ben-id', balance: 500 },
    ]);
    const settlement = await send(app, 'GET', '/settlements/settlement-1', { token: benToken });
    expect((settlement.body as { history: { status: string }[] }).history.map(change => change.status)).toEqual([
      'pending',
      'paid',
    ]);
  }

  it('serves a fresh database at once, and creates no file when none is named', async () => {
    const app = await startApplication(directory.databaseUrl, { databasePath: directory.legacyPath });
    expect(existsSync(directory.legacyPath)).toBe(false);
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    expect(ana.token).toEqual(expect.any(String));
    await app.stop();
  });
});
