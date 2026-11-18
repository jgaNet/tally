import { createHmac } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import pg from 'pg';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The move into PostgreSQL (feature 30, ADR 25): a server started on a database that holds nothing of Tally's yet, while DATABASE_PATH
 * names a file an earlier version kept, moves everything the file holds into it and then serves; a payment waiting at the provider is
 * counted once when its webhook comes; a fact stored and not relayed is relayed after the move, and one relayed before it is not again;
 * the file is not read again; two servers started at once move it once.
 *
 * The file is a real one, kept by the version before this one (`fixtures/`): two members who signed in, a group of them, a dinner of 3000
 * split between them, 500 settled in cash, 600 asked through the provider and waiting there, the notice of the dinner made, and the fact of
 * a second dinner stored and not yet relayed.
 */
interface Person {
  email: string;
  token: string;
  id: string;
}
const FIXTURES = join(process.cwd(), 'src', 'Bootstrap', 'Fastify', 'fixtures');
const fixture = JSON.parse(readFileSync(join(FIXTURES, 'tally-before-postgresql.json'), 'utf8')) as {
  password: string;
  ann: Person;
  bob: Person;
  groupId: string;
  settlementId: string;
  paymentId: string;
  secret: string;
  pendingExpense: string;
  counts: Record<string, number>;
};
const { ann, bob, groupId, settlementId, paymentId } = fixture;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
let directory: string;
const started: FastifyApplication[] = [];

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'tally-move-'));
});
afterAll(async () => {
  for (const app of started.splice(0)) await app.stop();
  rmSync(directory, { recursive: true, force: true });
});

/** The file of an earlier version, as a copy of its own. */
const aFile = () => {
  const path = join(directory, `${Math.random().toString(36).slice(2)}.sqlite`);
  copyFileSync(join(FIXTURES, 'tally-before-postgresql.sqlite'), path);
  return path;
};

const start = async (databaseUrl: string, databasePath?: string) => {
  const app = await createApplication({
    databaseUrl,
    databasePath,
    logger: silent,
    providerUrl: 'http://127.0.0.1:9',
    providerWebhookSecret: fixture.secret,
  });
  await app.start(0);
  started.push(app);
  return { app, http: apiClient(app.address), api: `/${app.apiPrefix}` };
};
const stop = async (app: FastifyApplication) => {
  started.splice(started.indexOf(app), 1);
  await app.stop();
};

const eventually = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
  let value = await read();
  for (let attempt = 0; attempt < 100 && !done(value); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
};

const count = async (databaseUrl: string, table: string): Promise<number> => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return Number((await client.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
  } finally {
    await client.end();
  }
};

describe('a server started on an empty database, with the file an earlier version kept', () => {
  it('moves everything the file holds, then serves it as it was', async () => {
    const databaseUrl = await freshDatabase();
    const { http, api } = await start(databaseUrl, aFile());

    // The token an earlier server signed still proves who they are, and the password still signs them in.
    expect((await http.request('GET', `${api}/accounts/me`, { token: ann.token })).body).toMatchObject({
      id: ann.id,
      email: ann.email,
    });
    expect(
      (await http.request('POST', `${api}/accounts/login`, { body: { email: bob.email, password: fixture.password } }))
        .status,
    ).toBe(200);
    expect((await http.request('GET', `${api}/groups/mine`, { token: bob.token })).body).toEqual([
      expect.objectContaining({ id: groupId, name: 'Trip', currency: 'EUR', ownerId: ann.id }),
    ]);
    expect((await http.request('GET', `${api}/groups/${groupId}/members`, { token: ann.token })).body).toEqual([
      expect.objectContaining({ memberId: ann.id, role: 'owner' }),
      expect.objectContaining({ memberId: bob.id, role: 'member' }),
    ]);
    // 3000 split between two, and 500 settled in cash; the 600 waiting at the provider is not counted.
    expect((await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token })).body).toEqual([
      { memberId: ann.id, balance: 1000 },
      { memberId: bob.id, balance: -1000 },
    ]);
    expect((await http.request('GET', `${api}/settlements/${settlementId}`, { token: bob.token })).body).toMatchObject({
      id: settlementId,
      status: 'pending',
      method: 'provider',
      amount: 600,
      history: [expect.objectContaining({ status: 'pending' })],
    });
    expect((await http.request('GET', `${api}/groups/${groupId}/audit`, { token: ann.token })).body).toHaveLength(2);

    // Every row the file held is in the database.
    for (const [table, rows] of Object.entries(fixture.counts)) {
      if (table === 'outbox') continue;
      expect(await count(databaseUrl, table)).toBeGreaterThanOrEqual(rows);
    }
  });

  it('relays the fact stored and not relayed, once, and not the one relayed before the move', async () => {
    const databaseUrl = await freshDatabase();
    const { http, api } = await start(databaseUrl, aFile());

    // Bob had the notice of the first dinner; the second dinner's fact goes out after the move: two notices, not three.
    const notices = await eventually(
      async () => (await http.request('GET', `${api}/notices`, { token: bob.token })).body as unknown[],
      list => list.length >= 2,
    );
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(notices).toHaveLength(2);
    expect(((await http.request('GET', `${api}/notices`, { token: bob.token })).body as unknown[]).length).toBe(2);
    expect(await count(databaseUrl, 'outbox')).toBe(0);
  });

  it('counts the payment waiting at the provider once, when its webhook comes', async () => {
    const databaseUrl = await freshDatabase();
    const { http, api } = await start(databaseUrl, aFile());

    const webhook = { id: 'wh-1', paymentId, status: 'succeeded', at: '2026-03-01T10:00:00.000Z' };
    const signature = createHmac('sha256', fixture.secret).update(JSON.stringify(webhook)).digest('hex');
    const send = (body: typeof webhook) =>
      http.request('POST', `${api}/provider/webhooks`, { body, headers: { 'provider-signature': signature } });
    expect((await send(webhook)).status).toBe(204);
    expect((await send(webhook)).status).toBe(204);

    expect(
      (
        (await http.request('GET', `${api}/settlements/${settlementId}`, { token: bob.token })).body as {
          status: string;
        }
      ).status,
    ).toBe('paid');
    expect((await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token })).body).toEqual([
      { memberId: ann.id, balance: 400 },
      { memberId: bob.id, balance: -400 },
    ]);
  });

  it('does not read the file again once the database holds the application: it serves what the database holds', async () => {
    const databaseUrl = await freshDatabase();
    const path = aFile();
    const first = await start(databaseUrl, path);
    await first.http.request('POST', `${first.api}/accounts`, {
      body: { email: 'cy@example.com', password: fixture.password, name: 'Cy' },
    });
    await stop(first.app);

    writeFileSync(path, 'not a database any more');
    const second = await start(databaseUrl, path);
    expect(
      (
        await second.http.request('POST', `${second.api}/accounts/login`, {
          body: { email: 'cy@example.com', password: fixture.password },
        })
      ).status,
    ).toBe(200);
    expect((await second.http.request('GET', `${second.api}/accounts/me`, { token: ann.token })).status).toBe(200);
    expect(await count(databaseUrl, 'accounts')).toBe(3);
  });

  it('moves it once when two servers are started at the same time on the same empty database', async () => {
    const databaseUrl = await freshDatabase();
    const path = aFile();
    const [one, other] = await Promise.all([start(databaseUrl, path), start(databaseUrl, path)]);

    expect(await count(databaseUrl, 'accounts')).toBe(2);
    expect(await count(databaseUrl, 'expenses')).toBe(1);
    expect((await one.http.request('GET', `${one.api}/accounts/me`, { token: ann.token })).status).toBe(200);
    expect((await other.http.request('GET', `${other.api}/accounts/me`, { token: bob.token })).status).toBe(200);
  });
});

describe('a server started on an empty database, with no such file', () => {
  it('prepares the database and serves at once', async () => {
    const { http, api } = await start(await freshDatabase(), join(directory, 'there-is-none.sqlite'));
    expect(
      (
        await http.request('POST', `${api}/accounts`, {
          body: { email: 'new@example.com', password: fixture.password, name: 'New' },
        })
      ).status,
    ).toBe(201);
    expect((await http.request('GET', `${api}/groups/mine`, { token: ann.token })).status).toBe(401);
  });
});
