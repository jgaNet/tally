import { ChildProcess, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The move from the SQLite file (ADR 22). `tally-before-postgresql.sqlite` was kept by the version before this one, driven
 * over HTTP: Ann and Bob, a group, a dinner of 60 split between them, Bob paying Ann 30 through the provider (payment
 * `prov-moved-1`, still pending), and an outbox entry stored and not relayed yet. A server started on an empty database
 * with `DATABASE_PATH` naming a copy of it moves it all, then serves.
 */
const FIXTURE = {
  ann: 'ed7635ed-4c15-41ef-9110-eec63a405756',
  bob: 'dfaf718c-9f1e-411e-97fe-c4a32b5910ef',
  group: '53306a1c-8d73-4ebf-84d2-369e361914b6',
  settlement: 'a01a6fbb-ad2a-4a28-bda2-a9a75d958cc5',
  annToken: 'ed7635ed-4c15-41ef-9110-eec63a405756.nKEiqqhG3CdlIOh7ORJujEzsIKGUJqUixl7x_WUW_Ws',
  unrelayed: '22222222-2222-4222-8222-222222222222',
};
const SECRET = 'shared-with-the-provider';
const SECOND_PORT = 21900;

let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let bobToken: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-move-'));
  process.env.DATABASE_PATH = join(directory, 'tally.sqlite');
  copyFileSync(join(process.cwd(), 'src/Bootstrap/Fastify/tally-before-postgresql.sqlite'), process.env.DATABASE_PATH);
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const login = await http.request('POST', `${api}/accounts/login`, {
    body: { email: 'bob@moved.example', password: 'correct horse' },
  });
  bobToken = (login.body as { token: string }).token;
}, 60000);

afterAll(async () => {
  await app.stop();
  delete process.env.DATABASE_PATH;
  rmSync(directory, { recursive: true, force: true });
});

type Body = Record<string, unknown>;

async function balances(token: string) {
  const { body } = await http.get(`${api}/groups/${FIXTURE.group}/balances`, { token });
  return Object.fromEntries((body as { memberId: string; balance: number }[]).map(b => [b.memberId, b.balance]));
}

async function webhook(payload: Body) {
  const signature = createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex');
  return http.request('POST', `${api}/provider/webhooks`, {
    body: payload,
    headers: { 'provider-signature': signature },
  });
}

async function settlement() {
  return (await http.get(`${api}/settlements/${FIXTURE.settlement}`, { token: bobToken })).body as Body;
}

describe('a server started on an empty PostgreSQL database, with the SQLite file of an earlier version', () => {
  it('moves the accounts, their passwords and the tokens they were given', async () => {
    expect(bobToken).toEqual(expect.any(String));
    const me = await http.get(`${api}/accounts/me`, { token: FIXTURE.annToken });
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ id: FIXTURE.ann, email: 'ann@moved.example', name: 'Ann' });
  });

  it('moves the groups, their members and their expenses, with what this version gives an expense', async () => {
    const mine = await http.get(`${api}/groups/mine`, { token: bobToken });
    expect(mine.body).toEqual([{ id: FIXTURE.group, name: 'Trip', currency: 'EUR', ownerId: FIXTURE.ann }]);
    const members = await http.get(`${api}/groups/${FIXTURE.group}/members`, { token: bobToken });
    expect((members.body as Body[]).map(member => [member.memberId, member.role])).toEqual([
      [FIXTURE.ann, 'owner'],
      [FIXTURE.bob, 'member'],
    ]);
    const expenses = await http.get(`${api}/groups/${FIXTURE.group}/expenses`, { token: bobToken });
    expect(expenses.body).toEqual([
      expect.objectContaining({
        description: 'Dinner',
        amount: 60,
        date: '2026-11-01',
        paidBy: FIXTURE.ann,
        version: 1,
      }),
    ]);
  });

  it('relays the fact the file stored and had not relayed, once', async () => {
    const relayed = await http.get(`${api}/operations/${FIXTURE.unrelayed}`);
    expect(relayed.status).toBe(200);
    expect(relayed.body).toMatchObject({ id: FIXTURE.unrelayed, name: 'StarterChecked' });
    const left = await PostgresDatabase.shared().exclusive(connection =>
      connection.rows('SELECT id FROM outbox WHERE id = ?', FIXTURE.unrelayed),
    );
    expect(left).toEqual([]);
  });

  it('keeps the payment waiting at the provider pending, and counts it once when its webhook comes', async () => {
    expect(await settlement()).toMatchObject({ status: 'pending', method: 'provider', amount: 30 });
    expect(await balances(bobToken)).toEqual({ [FIXTURE.ann]: 30, [FIXTURE.bob]: -30 });

    const told = { id: 'wh-moved-1', paymentId: 'prov-moved-1', status: 'succeeded', at: '2026-11-18T10:00:00Z' };
    expect((await webhook(told)).status).toBeLessThan(300);
    expect((await webhook(told)).status).toBeLessThan(300);
    expect((await webhook({ ...told, id: 'wh-moved-2' })).status).toBeLessThan(300);

    const paid = await settlement();
    expect(paid.status).toBe('paid');
    expect((paid.history as Body[]).map(entry => entry.status)).toEqual(['pending', 'paid']);
    expect(await balances(bobToken)).toEqual({ [FIXTURE.ann]: 0, [FIXTURE.bob]: 0 });
  });

  it('is not moved again by a second server on the same database, which answers the same, killed or not', async () => {
    let second: ChildProcess | undefined;
    try {
      second = spawn(process.execPath, ['--import', 'tsx', 'src/Bootstrap/Fastify/application.ts'], {
        env: { ...process.env, NODE_ENV: 'production', PORT: String(SECOND_PORT) },
        stdio: 'ignore',
      });
      const other = apiClient(`http://127.0.0.1:${SECOND_PORT}`);
      let answer: { status: number; body: unknown } | undefined;
      for (let attempt = 0; attempt < 150 && answer?.status !== 200; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        answer = await other.get(`${api}/groups/${FIXTURE.group}/balances`, { token: bobToken }).catch(() => undefined);
      }
      expect(answer?.status).toBe(200);
      expect(answer?.body).toEqual([
        { memberId: FIXTURE.ann, balance: 0 },
        { memberId: FIXTURE.bob, balance: 0 },
      ]);
    } finally {
      second?.kill('SIGKILL');
    }
    const counted = await PostgresDatabase.shared().exclusive(async connection => ({
      accounts: await connection.rows('SELECT id FROM accounts'),
      storage: await connection.rows<{ moved_from: string }>('SELECT moved_from FROM tally_storage'),
    }));
    expect(counted.accounts).toHaveLength(2);
    expect(counted.storage).toEqual([{ moved_from: process.env.DATABASE_PATH }]);
    expect(await balances(bobToken)).toEqual({ [FIXTURE.ann]: 0, [FIXTURE.bob]: 0 });
  }, 60000);
});

/** Sends a command as the caller and follows its operation to its outcome. */
async function send(method: string, path: string, token: string, body?: Body) {
  const answer = await http.request(method, `${api}${path}`, { body, token });
  expect(answer.status).toBe(202);
  const operationId = (answer.body as { operationId: string }).operationId;
  for (let attempt = 0; attempt < 100; attempt++) {
    const { body: operation } = await http.get(`${api}/operations/${operationId}`, { token });
    if ((operation as Body).status !== 'PENDING') return operation as Body;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

describe('Groups → Ledger (GroupMembers, GroupCurrency, PassedBalances): on the moved database, a group Groups makes is the one Ledger keeps expenses in, by the id it answered', () => {
  it('creates a group, and finds the expense recorded in it, its members and its currency, by that id', async () => {
    const created = await send('POST', '/groups', FIXTURE.annToken, { name: 'After the move', currency: 'USD' });
    expect(created.status).toBe('SUCCESS');
    const groupId = (created.result as { id: string }).id;

    const recorded = await send('POST', `/groups/${groupId}/expenses`, FIXTURE.annToken, {
      description: 'Taxi',
      amount: 40,
      date: '2026-11-18',
      splitBetween: [FIXTURE.ann],
    });
    expect(recorded.status).toBe('SUCCESS');
    const expenses = await http.get(`${api}/groups/${groupId}/expenses`, { token: FIXTURE.annToken });
    expect(expenses.body).toEqual([expect.objectContaining({ groupId, description: 'Taxi', amount: 40 })]);
    const audit = await http.get(`${api}/groups/${groupId}/audit`, { token: FIXTURE.annToken });
    expect(audit.status).toBe(200);
  });
});

describe('Settlements → Ledger (SettledAmounts, SettlementAudit): on the moved database, a settlement Settlements records is one Ledger counts and reads, by the id the recording answered', () => {
  it('records a cash settlement in the moved group, and finds it in the audit and the statement by that id', async () => {
    await send('POST', `/groups/${FIXTURE.group}/expenses`, FIXTURE.annToken, {
      description: 'Lunch',
      amount: 20,
      date: '2026-11-18',
      splitBetween: [FIXTURE.ann, FIXTURE.bob],
    });
    const settled = await send('POST', `/groups/${FIXTURE.group}/settlements/cash`, FIXTURE.annToken, {
      from: FIXTURE.bob,
      amount: 10,
    });
    expect(settled.status).toBe('SUCCESS');
    const settlementId = (settled.result as { id: string }).id;

    const audit = await http.get(`${api}/groups/${FIXTURE.group}/audit`, { token: bobToken });
    expect((audit.body as Body[]).find(entry => entry.subjectId === settlementId)).toMatchObject({
      action: 'settlement-paid',
      amount: 10,
    });
    const statement = await http.get(`${api}/groups/${FIXTURE.group}/members/${FIXTURE.bob}/statement`, {
      token: bobToken,
    });
    expect(((statement.body as Body).entries as Body[]).some(entry => entry.settlementId === settlementId)).toBe(true);
    expect(await balances(bobToken)).toEqual({ [FIXTURE.ann]: 0, [FIXTURE.bob]: 0 });
  });
});
