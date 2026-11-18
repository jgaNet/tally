import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Currencies with no minor unit or with three decimals, over HTTP (request 40, the API's fragment 40): a group may be in them, an
 * amount is kept in its currency's own minor unit, and an expense in another currency is converted by what one unit of each is worth.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const PAST_DAY = '2020-01-15';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-currency-precision-'));
  app = await createApplication({ databaseUrl: await freshDatabase(), logger: silent });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
});
afterAll(async () => {
  await app.stop();
  rmSync(directory, { recursive: true, force: true });
});

async function person(name: string, email: string) {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id, name };
}

let ann: Awaited<ReturnType<typeof person>>;
let bob: Awaited<ReturnType<typeof person>>;

/** A group in `currency`, with Bob in it. */
const groupIn = async (currency: string) => {
  const created = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: `Trip ${currency}`, currency },
  });
  expect(created.status).toBe(201);
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: bob.token,
  });
  return groupId;
};

const record = (groupId: string, body: Record<string, unknown>) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { token: ann.token, body });
const read = (id: string) => http.request('GET', `${api}/expenses/${id}`, { token: bob.token });

describe('a group in a currency with no minor unit, or with three decimals (request 40)', () => {
  it('is created in JPY, KRW, KWD and BHD, and refuses a code that is not Tally’s', async () => {
    for (const currency of ['JPY', 'KRW', 'KWD', 'BHD']) {
      const created = await http.request('POST', `${api}/groups`, { token: ann.token, body: { name: 'x', currency } });
      expect(created.status).toBe(201);
      const fetched = await http.request('GET', `${api}/groups/${(created.body as { id: string }).id}`, {
        token: ann.token,
      });
      expect(fetched.body).toMatchObject({ currency });
    }
    expect(
      (await http.request('POST', `${api}/groups`, { token: ann.token, body: { name: 'x', currency: 'NOK' } })).status,
    ).toBe(422);
  });

  it('keeps an amount in the group’s own minor unit: 1250 yen is 1250, and it is split as it is', async () => {
    const groupId = await groupIn('JPY');
    const recorded = await record(groupId, {
      description: 'Ramen',
      amount: 1250,
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });
    expect(recorded.status).toBe(201);
    expect(await read((recorded.body as { id: string }).id)).toMatchObject({ body: { amount: 1250 } });
  });

  it('converts an expense in euros into yen, 12.50 euros at 161.5 being 2019 yen', async () => {
    const groupId = await groupIn('JPY');
    const recorded = await record(groupId, {
      description: 'Museum',
      original: { currency: 'EUR', amount: 1250, rate: '161.5' },
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });
    expect(recorded.status).toBe(201);
    expect(await read((recorded.body as { id: string }).id)).toMatchObject({
      body: { amount: 2019, original: { currency: 'EUR', amount: 1250, rate: '161.5' } },
    });
  });

  it('converts an expense in dollars into dinars, 10 dollars at 0.3075 being 3075 thousandths', async () => {
    const groupId = await groupIn('KWD');
    const recorded = await record(groupId, {
      description: 'Souk',
      original: { currency: 'USD', amount: 1000, rate: '0.3075' },
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });
    expect(recorded.status).toBe(201);
    expect(await read((recorded.body as { id: string }).id)).toMatchObject({ body: { amount: 3075 } });
  });

  it('converts an expense in yen into euros, 10 000 yen at 0.0062 being 6200 hundredths', async () => {
    const groupId = await groupIn('EUR');
    const recorded = await record(groupId, {
      description: 'Shinkansen',
      original: { currency: 'JPY', amount: 10000, rate: '0.0062' },
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });
    expect(recorded.status).toBe(201);
    expect(await read((recorded.body as { id: string }).id)).toMatchObject({ body: { amount: 6200 } });
  });
});
