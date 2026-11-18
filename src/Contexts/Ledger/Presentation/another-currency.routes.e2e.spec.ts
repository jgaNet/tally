import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * An expense in another currency, over HTTP (request 21, the API's fragment 21): it is recorded and edited at the rate its payer
 * states, the amount in the group's currency is what is split and read back, the original is kept as given, and the refusals the
 * domain makes are named.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const PAST_DAY = '2020-01-15';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-another-currency-'));
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

/** A group in euros, with Bob in it: the expenses below are paid in francs or dollars and counted in euros. */
const groupWithBob = async () => {
  const created = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: 'Zurich', currency: 'EUR' },
  });
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

describe('recording an expense in another currency', () => {
  it('converts the original at its rate, splits the amount in the group’s currency, and keeps the currency, amount and rate', async () => {
    const groupId = await groupWithBob();
    const recorded = await record(groupId, {
      description: 'Train',
      original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });
    expect(recorded.status).toBe(201);
    const { id } = recorded.body as { id: string };

    const { status, body } = await read(id);
    expect(status).toBe(200);
    expect(body).toEqual({
      id,
      groupId,
      category: 'other',
      description: 'Train',
      amount: 1311,
      date: PAST_DAY,
      paidBy: ann.id,
      splitKind: 'equal',
      shares: [
        { memberId: ann.id, amount: 656 },
        { memberId: bob.id, amount: 655 },
      ],
      version: 1,
      original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
    });
  });

  it('reads the rate back as the string it was given, and rounds a half up', async () => {
    const groupId = await groupWithBob();
    const { body } = await record(groupId, {
      description: 'Lunch',
      original: { currency: 'USD', amount: 1000, rate: '0.9545' },
      date: PAST_DAY,
      splitBetween: [ann.id],
    });
    const { body: read1 } = await read((body as { id: string }).id);
    expect(read1).toMatchObject({ amount: 955, original: { currency: 'USD', amount: 1000, rate: '0.9545' } });
  });

  it('keeps no original for an expense in the group’s currency', async () => {
    const groupId = await groupWithBob();
    const { body } = await record(groupId, {
      description: 'Bread',
      amount: 250,
      date: PAST_DAY,
      splitBetween: [ann.id],
    });
    const { body: read1 } = await read((body as { id: string }).id);
    expect(read1).not.toHaveProperty('original');
  });

  it('refuses a body with both an amount and an original, or neither, as 400 before anything is recorded', async () => {
    const groupId = await groupWithBob();
    const original = { currency: 'CHF', amount: 1, rate: '1' };
    const both = await record(groupId, {
      description: 'x',
      amount: 1,
      original,
      date: PAST_DAY,
      splitBetween: [ann.id],
    });
    const neither = await record(groupId, { description: 'x', date: PAST_DAY, splitBetween: [ann.id] });
    expect(both.status).toBe(400);
    expect(neither.status).toBe(400);
  });

  it.each([
    ['a currency that is not Tally’s', { currency: 'JPY', amount: 100, rate: '1' }, 'InvalidOriginalCurrency'],
    ['the group’s own currency', { currency: 'EUR', amount: 100, rate: '1' }, 'OriginalCurrencyIsGroupCurrency'],
    ['an amount of zero', { currency: 'CHF', amount: 0, rate: '1' }, 'InvalidOriginalAmount'],
    ['a rate of zero', { currency: 'CHF', amount: 100, rate: '0' }, 'InvalidOriginalRate'],
    [
      'a rate with seven digits after the point',
      { currency: 'CHF', amount: 100, rate: '1.1234567' },
      'InvalidOriginalRate',
    ],
    ['a converted amount that rounds to zero', { currency: 'CHF', amount: 1, rate: '0.1' }, 'InvalidExpenseAmount'],
    [
      'a converted amount above 100 000 000',
      { currency: 'CHF', amount: 100_000_000, rate: '2' },
      'InvalidExpenseAmount',
    ],
  ])('refuses %s with 422 naming the rule', async (_label, original, type) => {
    const groupId = await groupWithBob();
    const { status, body } = await record(groupId, {
      description: 'Bread',
      original,
      date: PAST_DAY,
      splitBetween: [ann.id],
    });
    expect(status).toBe(422);
    expect(body).toEqual({ type, message: expect.any(String) });
  });
});

describe('editing an expense in another currency', () => {
  it('gives the expense again whole, in its original currency at the new rate, from the version read', async () => {
    const groupId = await groupWithBob();
    const { body } = await record(groupId, {
      description: 'Train',
      original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
      date: PAST_DAY,
      splitBetween: [ann.id],
    });
    const id = (body as { id: string }).id;

    const edited = await http.request('PUT', `${api}/expenses/${id}`, {
      token: ann.token,
      body: {
        description: 'Train',
        original: { currency: 'USD', amount: 2000, rate: '0.5' },
        date: PAST_DAY,
        splitBetween: [ann.id, bob.id],
        version: 1,
      },
    });
    expect(edited.status).toBe(204);
    const { body: read1 } = await read(id);
    expect(read1).toMatchObject({
      amount: 1000,
      version: 2,
      original: { currency: 'USD', amount: 2000, rate: '0.5' },
    });
  });

  it('is in the group’s currency once it is edited with an amount, and keeps no original', async () => {
    const groupId = await groupWithBob();
    const { body } = await record(groupId, {
      description: 'Train',
      original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
      date: PAST_DAY,
      splitBetween: [ann.id],
    });
    const id = (body as { id: string }).id;

    const edited = await http.request('PUT', `${api}/expenses/${id}`, {
      token: ann.token,
      body: { description: 'Train', amount: 900, date: PAST_DAY, splitBetween: [ann.id], version: 1 },
    });
    expect(edited.status).toBe(204);
    const { body: read1 } = await read(id);
    expect(read1).toMatchObject({ amount: 900, version: 2 });
    expect(read1).not.toHaveProperty('original');
  });
});

describe('Groups → Ledger', () => {
  it('reads the group’s currency through Groups: an expense in the group’s own currency is refused, another one is kept, and the group’s id finds it in Ledger', async () => {
    const created = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Basel', currency: 'CHF' },
    });
    const groupId = (created.body as { id: string }).id;
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: bob.token,
    });

    const own = await record(groupId, {
      description: 'Coffee',
      original: { currency: 'CHF', amount: 500, rate: '1' },
      date: PAST_DAY,
      splitBetween: [ann.id],
    });
    expect(own.status).toBe(422);
    expect(own.body).toEqual({ type: 'OriginalCurrencyIsGroupCurrency', message: expect.any(String) });

    const other = await record(groupId, {
      description: 'Coffee',
      original: { currency: 'EUR', amount: 500, rate: '1.04' },
      date: PAST_DAY,
      splitBetween: [ann.id, bob.id],
    });
    expect(other.status).toBe(201);

    const listed = await http.request('GET', `${api}/groups/${groupId}/expenses`, { token: bob.token });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({
        id: (other.body as { id: string }).id,
        groupId,
        amount: 520,
        original: { currency: 'EUR', amount: 500, rate: '1.04' },
      }),
    ]);
  });
});
