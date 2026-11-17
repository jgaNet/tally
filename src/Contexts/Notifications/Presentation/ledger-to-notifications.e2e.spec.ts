import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Ledger → Notifications (ADR 14): Ledger publishes `ExpenseRecorded` through the outbox, and Notifications makes one notice for
 * each member of the split but the payer. Over HTTP: the notices arrive shortly after the expense is recorded, without anyone
 * acting; an edit and a deletion tell nobody; each person reads only their own, the most recent first.
 */

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-ledger-to-notifications-')), 'tally.sqlite');
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
});

let accountCount = 0;
async function signedInPerson(name: string): Promise<{ token: string; id: string }> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const password = 'a long password';
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const { token } = (await http.request('POST', `${api}/accounts/login`, { body: { email, password } })).body as {
    token: string;
  };
  return { token, id: (created.body as { id: string }).id };
}

/**
 * The notices are made shortly after the expense is recorded: the test reads them until `count` have arrived, polling for up to
 * about three seconds (120 polls of 25 ms). Asked for none, it reads once more after a short wait, so an absence is not read too early.
 */
async function noticesOf(person: { token: string }, count: number): Promise<{ amount: number; expenseId: string }[]> {
  let body: { amount: number; expenseId: string }[] = [];
  for (let poll = 0; poll < 120; poll++) {
    const answer = await http.request('GET', `${api}/notices`, { token: person.token });
    expect(answer.status).toBe(200);
    body = answer.body as { amount: number; expenseId: string }[];
    if (body.length >= count && (count > 0 || poll > 0)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return body;
}

async function groupOfThree() {
  const ada = await signedInPerson('Ada');
  const grace = await signedInPerson('Grace');
  const linus = await signedInPerson('Linus');
  const { id: groupId } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
  ).body as { id: string };
  for (const person of [grace, linus]) {
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  return { ada, grace, linus, groupId };
}

describe('Ledger → Notifications', () => {
  it('tells each member of an expense’s split but its payer, with their share, soon after it is recorded', async () => {
    const { ada, grace, linus, groupId } = await groupOfThree();

    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Pizzas', amount: 300, date: '2026-03-01', splitBetween: [ada.id, grace.id, linus.id] },
      token: ada.token,
    });
    expect(recorded.status).toBe(201);
    const { id: expenseId } = recorded.body as { id: string };

    expect(await noticesOf(grace, 1)).toEqual([
      expect.objectContaining({ kind: 'expense', groupId, expenseId, amount: 100 }),
    ]);
    expect(await noticesOf(linus, 1)).toEqual([
      expect.objectContaining({ kind: 'expense', groupId, expenseId, amount: 100 }),
    ]);
    // The payer recorded the expense: no notice.
    expect(await noticesOf(ada, 0)).toEqual([]);
  });

  it('makes no notice for an edit or a deletion, and lists each person’s notices the most recent first', async () => {
    const { ada, grace, linus, groupId } = await groupOfThree();
    const first = (
      await http.request('POST', `${api}/groups/${groupId}/expenses`, {
        body: { description: 'Pizzas', amount: 300, date: '2026-03-01', splitBetween: [ada.id, grace.id, linus.id] },
        token: ada.token,
      })
    ).body as { id: string };
    const second = (
      await http.request('POST', `${api}/groups/${groupId}/expenses`, {
        body: { description: 'Drinks', amount: 60, date: '2026-03-02', splitBetween: [ada.id, grace.id] },
        token: ada.token,
      })
    ).body as { id: string };

    // Grace has her share of both expenses, the latest first.
    expect((await noticesOf(grace, 2)).map(notice => notice.expenseId)).toEqual([second.id, first.id]);

    // Editing and deleting an expense tells nobody: Grace still has the two notices, and no more.
    const current = (await http.request('GET', `${api}/expenses/${first.id}`, { token: ada.token })).body as {
      version: number;
    };
    const edited = await http.request('PUT', `${api}/expenses/${first.id}`, {
      body: {
        description: 'Pizzas',
        amount: 150,
        date: '2026-03-01',
        splitBetween: [ada.id, grace.id],
        version: current.version,
      },
      token: ada.token,
    });
    expect(edited.status).toBe(204);
    const deleted = await http.request('DELETE', `${api}/expenses/${second.id}`, { token: ada.token });
    expect(deleted.status).toBe(204);

    await new Promise(resolve => setTimeout(resolve, 200));
    expect((await noticesOf(grace, 0)).length).toBe(2);
    expect((await noticesOf(linus, 0)).length).toBe(1);
  });

  it('answers a person’s own notices only, and refuses a request without a signed-in caller', async () => {
    const { ada, grace, groupId } = await groupOfThree();
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Snacks', amount: 40, date: '2026-03-03', splitBetween: [ada.id, grace.id] },
      token: ada.token,
    });

    expect((await noticesOf(grace, 1)).map(notice => notice.amount)).toEqual([20]);
    expect(await noticesOf(ada, 0)).toEqual([]);
    expect((await http.request('GET', `${api}/notices`)).status).toBe(401);
  });
});
