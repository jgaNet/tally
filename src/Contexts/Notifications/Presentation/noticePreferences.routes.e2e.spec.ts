import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('notice-preferences');
process.env.JOBS_INTERVAL_SECONDS = '0.2';

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

type Notice = { id: string; kind: string; groupId: string; expenseId?: string; amount: number; at: string };
type Preference = { kind: string; enabled: boolean };

const preferences = async (token: string) =>
  (await http.request('GET', `${api}/accounts/me/notice-preferences`, { token })).body as Preference[];
const setPreference = (token: string, kind: string, enabled: boolean) =>
  http.request('PUT', `${api}/accounts/me/notice-preferences/${kind}`, { token, body: { enabled } });
const notices = async (token: string) => (await http.request('GET', `${api}/notices`, { token })).body as Notice[];

/** A notice comes from the outbox's relay, a job's run: wait for it, for a while, rather than sleep for a fixed time. */
async function noticesWhen(token: string, ready: (list: Notice[]) => boolean): Promise<Notice[]> {
  let list = await notices(token);
  for (let attempt = 0; !ready(list) && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    list = await notices(token);
  }
  return list;
}

const record = (token: string, groupId: string, amount: number, splitBetween: string[]) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token,
    body: { description: 'Dinner', amount, date: '2026-01-15', splitBetween },
  });

describe('notice preferences (request 36)', () => {
  it('lists each kind, on, in the order the API lists them, to a person who never set one', async () => {
    const ann = await signedIn('prefs-fresh@example.com', 'Ann');
    expect(await preferences(ann.token)).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: true },
      { kind: 'budget', enabled: true },
    ]);
  });

  it('turns a kind off and on again for the caller, and changes nothing for anyone else', async () => {
    const ann = await signedIn('prefs-own-ann@example.com', 'Ann');
    const bob = await signedIn('prefs-own-bob@example.com', 'Bob');

    expect((await setPreference(bob.token, 'budget', false)).status).toBeLessThan(300);
    expect(await preferences(bob.token)).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: true },
      { kind: 'budget', enabled: false },
    ]);
    expect(await preferences(ann.token)).toContainEqual({ kind: 'budget', enabled: true });

    expect((await setPreference(bob.token, 'budget', true)).status).toBeLessThan(300);
    expect(await preferences(bob.token)).toContainEqual({ kind: 'budget', enabled: true });
  });

  it('refuses a kind that is not one of the three, and a value that is not a boolean', async () => {
    const ann = await signedIn('prefs-refused@example.com', 'Ann');
    const unknown = await setPreference(ann.token, 'weekly', false);
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(unknown.status).toBeLessThan(500);
    const shape = await http.request('PUT', `${api}/accounts/me/notice-preferences/expense`, {
      token: ann.token,
      body: { enabled: 'no' },
    });
    expect(shape.status).toBe(400);
  });

  it('asks for a signed-in caller to read or set them', async () => {
    expect((await http.request('GET', `${api}/accounts/me/notice-preferences`)).status).toBe(401);
    expect(
      (await http.request('PUT', `${api}/accounts/me/notice-preferences/expense`, { body: { enabled: false } })).status,
    ).toBe(401);
  });

  it('makes no expense notice to a member who turned them off, and tells the others as before', async () => {
    const ann = await signedIn('prefs-exp-ann@example.com', 'Ann');
    const bob = await signedIn('prefs-exp-bob@example.com', 'Bob');
    const cy = await signedIn('prefs-exp-cy@example.com', 'Cy');
    const groupId = await groupWith(ann, [bob, cy]);

    expect((await setPreference(bob.token, 'expense', false)).status).toBeLessThan(300);
    await record(ann.token, groupId, 3000, [ann.id, bob.id, cy.id]);
    // Cy is told of it once the reaction has run; Bob's decision was taken before Cy's notice was made.
    const cyNotices = await noticesWhen(cy.token, list => list.length > 0);
    expect(cyNotices).toHaveLength(1);
    expect(await notices(bob.token)).toEqual([]);

    expect((await setPreference(bob.token, 'expense', true)).status).toBeLessThan(300);
    await record(ann.token, groupId, 600, [ann.id, bob.id, cy.id]);
    const bobNotices = await noticesWhen(bob.token, list => list.length > 0);
    // Only the expense recorded after Bob turned them on: nothing missed while off is made later.
    expect(bobNotices).toEqual([expect.objectContaining({ kind: 'expense', groupId, amount: 200 })]);
    expect(await noticesWhen(cy.token, list => list.length > 1)).toHaveLength(2);
  }, 20000);
});

describe('Ledger → Notifications (ExpenseRecorded)', () => {
  it('tells a member of an expense the id the request that recorded it answered, and finds it by that id', async () => {
    const ann = await signedIn('ledger-notices-ann@example.com', 'Ann');
    const bob = await signedIn('ledger-notices-bob@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);

    const recorded = await record(ann.token, groupId, 1000, [ann.id, bob.id]);
    const expenseId = (recorded.body as { id: string }).id;

    const told = await noticesWhen(bob.token, list => list.some(notice => notice.expenseId === expenseId));
    expect(told).toEqual([expect.objectContaining({ kind: 'expense', groupId, expenseId, amount: 500 })]);
  }, 20000);
});
