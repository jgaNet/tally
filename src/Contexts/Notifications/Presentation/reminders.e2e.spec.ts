import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The reminders of request 18, over HTTP: the background job runs often, and a week is a fraction of a second here (the period is
 * REMINDER_PERIOD_SECONDS, given to the application). A member who owes more than 2000 for a period is reminded with a notice of kind
 * `reminder` that names no expense; again each period while it lasts; and not again once the debt is paid down.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const PERIOD_MS = 300;
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-reminders-'));
  app = await createApplication({
    databasePath: join(directory, 'tally.sqlite'),
    logger: silent,
    jobsIntervalSeconds: 0.05,
    reminderPeriodSeconds: PERIOD_MS / 1000,
  });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
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
  return { token, id: (me.body as { id: string }).id };
}

async function remindersOf(token: string): Promise<Array<Record<string, unknown>>> {
  const { body } = await http.request('GET', `${api}/notices`, { token });
  return (body as Array<Record<string, unknown>>).filter(notice => notice.kind === 'reminder');
}

describe('Reminders (request 18)', () => {
  it('reminds a member who owes more than 2000 for a period, again each period while it lasts, and stops once it is paid down', async () => {
    const ann = await person('Ann', 'ann@reminders.example.com');
    const bob = await person('Bob', 'bob@reminders.example.com');

    const { body: group } = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Reminders', currency: 'EUR' },
    });
    const groupId = (group as { id: string }).id;
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: bob.token,
    });

    // Ann pays 5000 for Ann and Bob: Bob owes 2500, more than 2000.
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Rent deposit', amount: 5000, date: '2020-01-10', splitBetween: [ann.id, bob.id] },
    });

    // Bob is reminded for the debt, which lasts, and reminded again in a later period.
    let reminders: Array<Record<string, unknown>> = [];
    for (let poll = 0; poll < 200 && reminders.length < 2; poll++) {
      reminders = await remindersOf(bob.token);
      if (reminders.length < 2) await sleep(25);
    }
    expect(reminders.length).toBeGreaterThanOrEqual(2);
    expect(reminders[0]).toEqual({
      id: expect.any(String),
      kind: 'reminder',
      groupId,
      amount: 2500,
      at: expect.any(String),
    });
    expect(reminders[0]).not.toHaveProperty('expenseId');
    expect(await remindersOf(ann.token)).toEqual([]);

    // Bob pays the debt down to 0, in cash, and no reminder is made after that.
    await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 2500 },
    });
    await sleep(150);
    const before = (await remindersOf(bob.token)).length;
    await sleep(4 * PERIOD_MS);
    expect((await remindersOf(bob.token)).length).toBe(before);
  });
});
