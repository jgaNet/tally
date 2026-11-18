import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('notices');

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  await database;
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

const record = async (token: string, groupId: string, body: unknown): Promise<string> =>
  ((await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token })).body as { id: string }).id;
const notices = async (token?: string) => (await http.request('GET', `${api}/notices`, { token })).body as Notice[];

type Notice = { id: string; kind: string; groupId: string; expenseId: string; amount: number; at: string };

/** A notice comes without anyone acting: wait for it a few seconds, never for the job's interval. */
async function noticesWhen(token: string, ready: (list: Notice[]) => boolean): Promise<Notice[]> {
  let list = await notices(token);
  for (let attempt = 0; !ready(list) && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    list = await notices(token);
  }
  return list;
}

describe('Ledger → Notifications: notices', () => {
  it('tells each member of the split but the payer, with their share, soon after the expense is recorded', async () => {
    const bob = await signedIn('notice-bob@example.com', 'Bob');
    const cy = await signedIn('notice-cy@example.com', 'Cy');
    const dee = await signedIn('notice-dee@example.com', 'Dee');
    const groupId = await groupWith(bob, [cy, dee]);

    const expenseId = await record(bob.token, groupId, {
      description: 'Pizzas',
      amount: 1000,
      date: '2026-01-15',
      splitBetween: [bob.id, cy.id, dee.id],
    });

    const forCy = await noticesWhen(cy.token, list => list.length > 0);
    expect(forCy).toEqual([
      { id: expect.any(String), kind: 'expense', groupId, expenseId, amount: 333, at: expect.any(String) },
    ]);
    const forDee = await noticesWhen(dee.token, list => list.length > 0);
    expect(forDee.map(({ amount, expenseId: id }) => ({ amount, id }))).toEqual([{ amount: 333, id: expenseId }]);
    expect(await notices(bob.token)).toEqual([]);
  });

  it('lists a person its own notices, the most recent first, and nobody else reads them', async () => {
    const ann = await signedIn('notice-ann@example.com', 'Ann');
    const eli = await signedIn('notice-eli@example.com', 'Eli');
    const groupId = await groupWith(ann, [eli]);

    const first = await record(ann.token, groupId, {
      description: 'One',
      amount: 400,
      date: '2026-01-10',
      splitBetween: [ann.id, eli.id],
    });
    await noticesWhen(eli.token, list => list.length === 1);
    const second = await record(ann.token, groupId, {
      description: 'Two',
      amount: 600,
      date: '2026-01-11',
      splitBetween: [ann.id, eli.id],
    });

    const list = await noticesWhen(eli.token, each => each.length === 2);
    expect(list.map(notice => notice.expenseId)).toEqual([second, first]);
    expect(await notices(ann.token)).toEqual([]);
    expect((await http.request('GET', `${api}/notices`)).status).toBe(401);
  });

  it('makes no notice of an edit or a deletion', async () => {
    const fay = await signedIn('notice-fay@example.com', 'Fay');
    const gus = await signedIn('notice-gus@example.com', 'Gus');
    const groupId = await groupWith(fay, [gus]);
    const expenseId = await record(fay.token, groupId, {
      description: 'Taxi',
      amount: 500,
      date: '2026-01-10',
      splitBetween: [fay.id, gus.id],
    });
    await noticesWhen(gus.token, list => list.length === 1);

    const expense = (await http.request('GET', `${api}/expenses/${expenseId}`, { token: fay.token })).body as {
      version: number;
    };
    await http.request('PUT', `${api}/expenses/${expenseId}`, {
      token: fay.token,
      body: {
        description: 'Taxi',
        amount: 700,
        date: '2026-01-10',
        splitBetween: [fay.id, gus.id],
        version: expense.version,
      },
    });
    await http.request('DELETE', `${api}/expenses/${expenseId}`, { token: fay.token });
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(await notices(gus.token)).toHaveLength(1);
  });
});
