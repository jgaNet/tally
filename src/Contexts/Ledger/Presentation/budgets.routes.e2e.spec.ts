import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

// The application keeps what it knows in the file DATABASE_PATH names: this suite has a file of its own.
process.env.DATABASE_PATH = join(tmpdir(), `tally-budgets-${randomUUID()}.db`);

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const probe = await signedIn('budget-clock@example.com', 'Clock');
  const probeGroup = await groupWith(probe, []);
  const members = (await http.request('GET', `${api}/groups/${probeGroup}/members`, { token: probe.token }))
    .body as Array<{ joinedAt: string }>;
  TODAY = members[0].joinedAt.slice(0, 10);
  THIS_MONTH = TODAY.slice(0, 7);
});
afterAll(() => app.stop());

const PASSWORD = 'a-good-password';
/** Today in UTC, which is the month the budgets read (request 24): the server's day, read from a member's `joinedAt` in `beforeAll`. */
let TODAY = '';
let THIS_MONTH = '';

async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

/** A group with its owner as first member, and each given account joined by an invitation, in that order. */
async function groupWith(owner: { token: string }, joiners: Array<{ token: string }>): Promise<string> {
  const group = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (group.body as { id: string }).id;
  for (const joiner of joiners) {
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: joiner.token,
    });
  }
  return groupId;
}

const setBudget = (token: string | undefined, groupId: string, category: string, amount: number) =>
  http.request('PUT', `${api}/groups/${groupId}/budgets/${category}`, { body: { amount }, token });
const readBudgets = (groupId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/budgets`, { token });
const record = (token: string, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const readNotices = async (token: string) => (await http.request('GET', `${api}/notices`, { token })).body as Notice[];

type Notice = {
  id: string;
  kind: string;
  groupId: string;
  category?: string;
  month?: string;
  budget?: number;
  amount: number;
};

/** A notice comes without anyone acting: wait for it a few seconds, never for the job's interval. */
async function noticesWhen(token: string, ready: (list: Notice[]) => boolean): Promise<Notice[]> {
  let list = await readNotices(token);
  for (let attempt = 0; !ready(list) && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    list = await readNotices(token);
  }
  return list;
}

describe('Groups → Ledger: budgets', () => {
  it("lets only the group's owner set, change and remove a budget, and lists the budgets in the order of the categories", async () => {
    const owner = await signedIn('budget-owner@example.com', 'Owner');
    const member = await signedIn('budget-member@example.com', 'Member');
    const stranger = await signedIn('budget-stranger@example.com', 'Stranger');
    const groupId = await groupWith(owner, [member]);

    expect((await setBudget(member.token, groupId, 'food', 50)).status).toBe(403);
    expect((await setBudget(stranger.token, groupId, 'food', 50)).status).toBe(404);
    expect((await setBudget(owner.token, groupId, 'travel', 200)).status).toBe(204);
    expect((await setBudget(owner.token, groupId, 'groceries', 400)).status).toBe(204);
    expect((await setBudget(owner.token, groupId, 'groceries', 350)).status).toBe(204);

    const listed = await readBudgets(groupId, member.token);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      { category: 'groceries', amount: 350, spent: 0 },
      { category: 'travel', amount: 200, spent: 0 },
    ]);
    expect((await readBudgets(groupId, stranger.token)).status).toBe(404);

    expect(
      (await http.request('DELETE', `${api}/groups/${groupId}/budgets/travel`, { token: member.token })).status,
    ).toBe(403);
    expect(
      (await http.request('DELETE', `${api}/groups/${groupId}/budgets/travel`, { token: owner.token })).status,
    ).toBe(204);
    expect((await readBudgets(groupId, owner.token)).body).toEqual([{ category: 'groceries', amount: 350, spent: 0 }]);
  });

  it('refuses a category that is none of the eight, and an amount out of range', async () => {
    const owner = await signedIn('budget-refuse@example.com', 'Refuser');
    const groupId = await groupWith(owner, []);
    expect((await setBudget(owner.token, groupId, 'parking', 50)).status).toBe(422);
    expect((await setBudget(owner.token, groupId, 'food', 0)).status).toBe(422);
    expect((await setBudget(owner.token, groupId, 'food', 100_000_001)).status).toBe(422);
  });

  it('counts an expense in its category and month, and reads what the current month spends in each', async () => {
    const owner = await signedIn('budget-spend@example.com', 'Spender');
    const groupId = await groupWith(owner, []);
    await setBudget(owner.token, groupId, 'rent', 1000);

    const rent = await record(owner.token, groupId, {
      description: 'Flat',
      amount: 400,
      date: TODAY,
      category: 'rent',
      splitBetween: [owner.id],
    });
    expect(rent.status).toBe(201);
    await record(owner.token, groupId, { description: 'Shopping', amount: 90, date: TODAY, splitBetween: [owner.id] });
    await record(owner.token, groupId, {
      description: 'Old rent',
      amount: 700,
      date: '2026-01-15',
      category: 'rent',
      splitBetween: [owner.id],
    });

    const expense = await http.request('GET', `${api}/expenses/${(rent.body as { id: string }).id}`, {
      token: owner.token,
    });
    expect((expense.body as { category: string }).category).toBe('rent');
    expect((await readBudgets(groupId, owner.token)).body).toEqual([{ category: 'rent', amount: 1000, spent: 400 }]);
    expect(THIS_MONTH).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe('Ledger → Notifications: budgets', () => {
  it('tells every member, the payer too, once when a month passes a budget, and not again for that month', async () => {
    const ada = await signedIn('budget-ada@example.com', 'Ada');
    const ben = await signedIn('budget-ben@example.com', 'Ben');
    const groupId = await groupWith(ada, [ben]);
    await setBudget(ada.token, groupId, 'groceries', 100);

    const first = await record(ben.token, groupId, {
      description: 'Market',
      amount: 150,
      date: TODAY,
      category: 'groceries',
      splitBetween: [ada.id, ben.id],
    });
    expect(first.status).toBe(201);

    const forBen = await noticesWhen(ben.token, list => list.length > 0);
    expect(forBen).toEqual([
      {
        id: expect.any(String),
        kind: 'budget',
        groupId,
        category: 'groceries',
        month: THIS_MONTH,
        budget: 100,
        amount: 150,
        at: expect.any(String),
      },
    ]);
    // Ada is told of the month too, beside the share of the expense she is in (a notice of its own kind).
    const forAda = await noticesWhen(ada.token, list => list.some(notice => notice.kind === 'budget'));
    expect(
      forAda
        .filter(notice => notice.kind === 'budget')
        .map(({ groupId: id, category, amount }) => ({ id, category, amount })),
    ).toEqual([{ id: groupId, category: 'groceries', amount: 150 }]);

    // The month goes further over: no other notice is made for it.
    await record(ada.token, groupId, {
      description: 'More market',
      amount: 60,
      date: TODAY,
      category: 'groceries',
      splitBetween: [ada.id, ben.id],
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await readNotices(ben.token)).filter(notice => notice.kind === 'budget')).toHaveLength(1);
  });
});
