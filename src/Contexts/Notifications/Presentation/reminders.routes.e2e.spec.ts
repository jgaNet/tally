import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

// The application keeps what it knows in the file DATABASE_PATH names: this suite has a file of its own. The background job runs
// every 0.2 seconds, and a debt that has lasted one second is reminded: a suite that waits for a week would not finish.
process.env.DATABASE_PATH = join(tmpdir(), `tally-reminders-${randomUUID()}.db`);
process.env.JOBS_INTERVAL_SECONDS = '0.2';
process.env.REMINDER_PERIOD_SECONDS = '1';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

const PASSWORD = 'a-good-password';

async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

async function groupWith(owner: { token: string }, joiner: { token: string }): Promise<string> {
  const group = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (group.body as { id: string }).id;
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: joiner.token,
  });
  return groupId;
}

type Notice = { id: string; kind: string; groupId: string; expenseId?: string; amount: number; at: string };

const notices = async (token: string): Promise<Notice[]> =>
  (await http.request('GET', `${api}/notices`, { token })).body as Notice[];
const reminders = async (token: string): Promise<Notice[]> => (await notices(token)).filter(n => n.kind === 'reminder');

/** A reminder comes without anyone acting: wait for the job, for a while, never for the period itself. */
async function remindersWhen(token: string, ready: (list: Notice[]) => boolean): Promise<Notice[]> {
  let list = await reminders(token);
  for (let attempt = 0; !ready(list) && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    list = await reminders(token);
  }
  return list;
}

/** Ann paid `amount` split equally with Bob, so Bob owes half of it. */
async function owedBy(ann: { token: string; id: string }, bob: { id: string }, groupId: string, amount: number) {
  await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token: ann.token,
    body: { description: 'Dinner', amount, date: '2026-01-15', splitBetween: [ann.id, bob.id] },
  });
}

describe('Settlements → Notifications (OutstandingDebts)', () => {
  it('reminds a member who still owes more than 2000 once the debt has lasted a period, with what is owed and no expense', async () => {
    const ann = await signedIn('reminders-ann@example.com', 'Ann');
    const bob = await signedIn('reminders-bob@example.com', 'Bob');
    const groupId = await groupWith(ann, bob);

    await owedBy(ann, bob, groupId, 10000);

    const list = await remindersWhen(bob.token, found => found.length > 0);
    expect(list[0]).toEqual({
      id: expect.any(String),
      kind: 'reminder',
      groupId,
      amount: 5000,
      at: expect.any(String),
    });
    expect(list[0]).not.toHaveProperty('expenseId');
    expect(await reminders(ann.token)).toEqual([]);
  }, 15000);

  it('counts a cash settlement against the debt, so the reminder is for what is still owed', async () => {
    const ann = await signedIn('reminders-settled-ann@example.com', 'Ann');
    const bob = await signedIn('reminders-settled-bob@example.com', 'Bob');
    const groupId = await groupWith(ann, bob);

    await owedBy(ann, bob, groupId, 10000);
    // Ann, the payee, records what Bob paid her in cash: 10.00 of the 50.00 Bob owed.
    const paid = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 1000 },
    });
    expect(paid.status).toBeLessThan(300);

    const list = await remindersWhen(bob.token, found => found.length > 0);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every(notice => notice.amount === 4000)).toBe(true);
  }, 15000);

  it('reminds nobody who owes 2000 or less', async () => {
    const ann = await signedIn('reminders-small-ann@example.com', 'Ann');
    const bob = await signedIn('reminders-small-bob@example.com', 'Bob');
    const groupId = await groupWith(ann, bob);

    await owedBy(ann, bob, groupId, 4000);
    await new Promise(resolve => setTimeout(resolve, 1600));
    expect(await reminders(bob.token)).toEqual([]);
  }, 15000);
});
