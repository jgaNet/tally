import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The recurring expenses of request 23, over HTTP. The background job runs often here, so the days that have come since a start in the
 * past are recorded at its first run, each once, however many runs follow; a stop keeps what was recorded and records nothing after.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
/** Today, as the server answers it: read from the `Date` of its answers, so that these tests read no clock of their own. */
let serverToday: Date;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-recurring-'));
  app = await createApplication({
    databasePath: join(directory, 'tally.sqlite'),
    logger: silent,
    jobsIntervalSeconds: 0.05,
  });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  serverToday = new Date((await http.request('GET', `${api}/accounts/me`)).headers.get('date') ?? '');
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

/** The day `months` before this month, on day `dayOfMonth`, in UTC: a start in the past. */
function startsOnMonthsAgo(months: number, dayOfMonth: number): string {
  const today = serverToday;
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - months, dayOfMonth))
    .toISOString()
    .slice(0, 10);
}

/** The days a recurring expense from `startsOn` has, up to today (UTC), as the request says they come: each month, the same day. */
function daysThatHaveCome(startsOn: string): string[] {
  const today = serverToday.toISOString().slice(0, 10);
  const [year, month, day] = startsOn.split('-').map(Number);
  const days: string[] = [];
  for (let y = year, m = month; ; m++) {
    if (m > 12) {
      m = 1;
      y++;
    }
    const current = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (current > today) break;
    days.push(current);
  }
  return days;
}

async function expensesNamed(token: string, groupId: string, description: string) {
  const { body } = await http.request('GET', `${api}/groups/${groupId}/expenses`, { token });
  return (body as Array<Record<string, unknown>>).filter(expense => expense.description === description);
}

/** Polls until the check holds, the background job running in between. */
async function until(check: () => Promise<boolean>, attempts = 320): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error('timed out');
}

describe('Recurring expenses (request 23)', () => {
  it('records each day that has come from its start, once, and reads it as it was given', async () => {
    const ann = await person('Ann', 'ann@recurring.example.com');
    const bob = await person('Bob', 'bob@recurring.example.com');
    const carl = await person('Carl', 'carl@recurring.example.com');

    const { body: group } = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Flat', currency: 'EUR' },
    });
    const groupId = (group as { id: string }).id;
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: bob.token,
    });

    const startsOn = startsOnMonthsAgo(2, 5);
    const rent = await http.request('POST', `${api}/groups/${groupId}/recurring`, {
      token: ann.token,
      body: { description: 'Rent', amount: 90000, startsOn, splitBetween: [ann.id, bob.id] },
    });
    expect(rent.status).toBe(201);
    const rentId = (rent.body as { id: string }).id;

    const internet = await http.request('POST', `${api}/groups/${groupId}/recurring`, {
      token: bob.token,
      body: {
        description: 'Internet',
        amount: 3000,
        startsOn: startsOnMonthsAgo(1, 1),
        splitByShares: [
          { memberId: bob.id, shares: 2 },
          { memberId: ann.id, shares: 1 },
        ],
      },
    });
    const internetId = (internet.body as { id: string }).id;

    // The days that have come are recorded at the runs that follow: each one expense, paid by Ann, split equally.
    const expected = daysThatHaveCome(startsOn);
    await until(async () => (await expensesNamed(ann.token, groupId, 'Rent')).length >= expected.length);
    await sleep(300);
    const rentExpenses = await expensesNamed(ann.token, groupId, 'Rent');
    expect(rentExpenses.map(expense => expense.date).sort()).toEqual(expected);
    expect(rentExpenses.every(expense => expense.paidBy === ann.id && expense.amount === 90000)).toBe(true);
    expect(rentExpenses.every(expense => (expense.shares as unknown[]).length === 2)).toBe(true);

    // Read: the split as it was given, the next day it records, the earliest set up first.
    const { body: read } = await http.request('GET', `${api}/recurring/${rentId}`, { token: bob.token });
    expect(read).toMatchObject({
      id: rentId,
      groupId,
      paidBy: ann.id,
      description: 'Rent',
      amount: 90000,
      startsOn,
      splitBetween: [ann.id, bob.id],
    });
    const nextDay = new Date(`${expected[expected.length - 1]}T00:00:00.000Z`);
    nextDay.setUTCMonth(nextDay.getUTCMonth() + 1);
    expect((read as { next: string }).next).toBe(nextDay.toISOString().slice(0, 10));
    expect(read).not.toHaveProperty('splitExactly');

    const { body: listed } = await http.request('GET', `${api}/groups/${groupId}/recurring`, { token: ann.token });
    expect((listed as Array<{ id: string }>).map(item => item.id)).toEqual([rentId, internetId]);
    expect(listed).toEqual([
      expect.objectContaining({ id: rentId }),
      expect.objectContaining({
        id: internetId,
        splitByShares: [
          { memberId: bob.id, shares: 2 },
          { memberId: ann.id, shares: 1 },
        ],
      }),
    ]);

    // Once: the runs that follow record nothing more for the days already recorded.
    await sleep(300);
    expect(await expensesNamed(ann.token, groupId, 'Rent')).toHaveLength(expected.length);

    // Outsiders see none of it: the same 404 as one that does not exist, and no set up in their group.
    expect((await http.request('GET', `${api}/recurring/${rentId}`, { token: carl.token })).status).toBe(404);
    expect((await http.request('GET', `${api}/groups/${groupId}/recurring`, { token: carl.token })).status).toBe(404);
    expect(
      (
        await http.request('POST', `${api}/groups/${groupId}/recurring`, {
          token: carl.token,
          body: { description: 'Gym', amount: 1000, startsOn, splitBetween: [carl.id] },
        })
      ).status,
    ).toBe(404);

    // Refusals: the body's shape is 400; the domain's values are 422.
    expect(
      (
        await http.request('POST', `${api}/groups/${groupId}/recurring`, {
          token: ann.token,
          body: {
            description: 'Gym',
            amount: 1000,
            startsOn,
            splitBetween: [ann.id],
            splitByShares: [{ memberId: ann.id, shares: 1 }],
          },
        })
      ).status,
    ).toBe(400);
    const badDay = await http.request('POST', `${api}/groups/${groupId}/recurring`, {
      token: ann.token,
      body: { description: 'Gym', amount: 1000, startsOn: startsOnMonthsAgo(1, 29), splitBetween: [ann.id] },
    });
    expect(badDay.status).toBe(422);
    expect(badDay.body).toMatchObject({ type: 'InvalidRecurringStartsOn' });

    // Stopping: only the payer or the owner. Bob, who is not the payer of the rent, is refused; Ann may stop it, and it is gone.
    expect((await http.request('DELETE', `${api}/recurring/${rentId}`, { token: bob.token })).status).toBe(403);
    expect((await http.request('DELETE', `${api}/recurring/${rentId}`, { token: ann.token })).status).toBe(204);
    expect((await http.request('GET', `${api}/recurring/${rentId}`, { token: ann.token })).status).toBe(404);
    await sleep(200);
    expect(await expensesNamed(ann.token, groupId, 'Rent')).toHaveLength(expected.length);
  });

  it('is stopped by the group owner when its payer is another member', async () => {
    const ann = await person('Owen', 'owen@recurring.example.com');
    const bob = await person('Bea', 'bea@recurring.example.com');
    const { body: group } = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Club', currency: 'USD' },
    });
    const groupId = (group as { id: string }).id;
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: bob.token,
    });

    const set = await http.request('POST', `${api}/groups/${groupId}/recurring`, {
      token: bob.token,
      body: {
        description: 'Dues',
        amount: 500,
        startsOn: '2999-01-01',
        splitExactly: [{ memberId: bob.id, amount: 500 }],
      },
    });
    expect(set.status).toBe(422);

    const future = await http.request('POST', `${api}/groups/${groupId}/recurring`, {
      token: bob.token,
      body: {
        description: 'Dues',
        amount: 500,
        startsOn: startsOnMonthsAgo(0, 28),
        splitExactly: [{ memberId: bob.id, amount: 500 }],
      },
    });
    expect(future.status).toBe(201);
    const id = (future.body as { id: string }).id;
    expect((await http.request('DELETE', `${api}/recurring/${id}`, { token: ann.token })).status).toBe(204);
    expect((await http.request('GET', `${api}/recurring/${id}`, { token: bob.token })).status).toBe(404);
  });
});

/**
 * The relationship Groups → Ledger (ADR 6): Ledger asks Groups who is in a group, through its own port. A group is made through the API,
 * its id is the one that request answered; a recurring expense is set up in it by that id, and Ledger finds it again by the same id, with
 * the group's members in the split and the expense its day records in the group's currency.
 */
describe('Groups → Ledger (GroupCurrency, GroupMembers)', () => {
  it('sets up a recurring expense in the group a request made, by that group id, and finds it by the same id', async () => {
    const ann = await person('Nia', 'nia@recurring-link.example.com');
    const bob = await person('Ola', 'ola@recurring-link.example.com');

    const made = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Link', currency: 'CHF' },
    });
    expect(made.status).toBe(201);
    const groupId = (made.body as { id: string }).id;
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: bob.token,
    });

    const set = await http.request('POST', `${api}/groups/${groupId}/recurring`, {
      token: ann.token,
      body: {
        description: 'Insurance',
        amount: 12000,
        startsOn: startsOnMonthsAgo(1, 2),
        splitBetween: [ann.id, bob.id],
      },
    });
    expect(set.status).toBe(201);
    const id = (set.body as { id: string }).id;

    const { body: found } = await http.request('GET', `${api}/recurring/${id}`, { token: bob.token });
    expect(found).toMatchObject({ id, groupId, paidBy: ann.id, splitBetween: [ann.id, bob.id] });

    const { body: listed } = await http.request('GET', `${api}/groups/${groupId}/recurring`, { token: bob.token });
    expect((listed as Array<{ id: string }>).map(item => item.id)).toEqual([id]);

    // The day that has come is recorded in the group's currency, for the members of the split that Groups answered.
    await until(async () => (await expensesNamed(ann.token, groupId, 'Insurance')).length >= 1);
    const [recorded] = await expensesNamed(ann.token, groupId, 'Insurance');
    expect(recorded).toMatchObject({ groupId, paidBy: ann.id, amount: 12000 });
  });
});
