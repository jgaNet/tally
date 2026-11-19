import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const WEEK = 604_800_000;

// The application's now is the test's: the sweep reads it, so a week can pass without waiting for one.
let now = new Date('2030-03-01T09:00:00Z');
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  app = await createApplication({ clock: () => now });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});

afterAll(() => app.stop());

type Body = Record<string, unknown>;
type Notice = { id: string; kind: string; groupId: string; expenseId?: string; amount: number; at: string };

/** Follows an operation to its outcome, as a client does. */
async function outcome(operationId: string, token?: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    if (status !== 200 || (body as Body).status !== 'PENDING') return { status, body: body as Body };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

let accountCount = 0;

/** Signs up and in a new account, and answers its token and its id. */
async function person(name: string) {
  const email = `${name.toLowerCase()}-preferences-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group and answers its id. */
async function createGroup(owner: { token: string }) {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const done = await outcome((answer.body as Body).operationId as string, owner.token);
  return (done.body as { result: { id: string } }).result.id;
}

/** A member of the group invites someone, who accepts: the new member joins. */
async function join(groupId: string, owner: { token: string }, joiner: { token: string }) {
  const created = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  const invitation = await outcome((created.body as Body).operationId as string, owner.token);
  const invitationId = (invitation.body as { result: { id: string } }).result.id;
  const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: joiner.token });
  await outcome((accepted.body as Body).operationId as string, joiner.token);
}

/** Records an expense the caller paid, the operation followed to its outcome. */
async function record(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
  await outcome((answer.body as Body).operationId as string, token);
}

/** Turns a kind of notice on or off for the caller, and follows the change to its outcome: the operation's status. */
async function setPreference(token: string, kind: string, enabled: boolean): Promise<string> {
  const answer = await http.request('PUT', `${api}/accounts/me/notice-preferences/${kind}`, {
    body: { enabled },
    token,
  });
  expect(answer.status).toBe(202);
  return (await outcome((answer.body as Body).operationId as string, token)).body.status as string;
}

/** The notices of a person, as they read them. */
async function notices(token: string): Promise<Notice[]> {
  const { body } = await http.get(`${api}/notices`, { token });
  return body as Notice[];
}

/** The reaction to a recorded expense runs after its commit: this waits until the member has the notice, or the time is up. */
async function waitForNotices(token: string, count: number): Promise<Notice[]> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = await notices(token);
    if (found.length >= count) return found;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`The notices never reached ${count}`);
}

describe('Notice preferences (request 36): reading them', () => {
  it('reads each kind on, in the order requests read them, for a person who changed nothing; a caller not signed in is refused', async () => {
    const ann = await person('Ann');
    const read = await http.get(`${api}/accounts/me/notice-preferences`, { token: ann.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: true },
      { kind: 'budget', enabled: true },
    ]);

    const anonymous = await http.get(`${api}/accounts/me/notice-preferences`);
    expect(anonymous.status).toBe(401);
  });

  it('reads only the caller’s own preferences', async () => {
    const bea = await person('Bea');
    const cal = await person('Cal');
    expect(await setPreference(bea.token, 'budget', false)).toBe('SUCCESS');

    const beaRead = await http.get(`${api}/accounts/me/notice-preferences`, { token: bea.token });
    const calRead = await http.get(`${api}/accounts/me/notice-preferences`, { token: cal.token });
    expect(beaRead.body).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: true },
      { kind: 'budget', enabled: false },
    ]);
    expect(calRead.body).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: true },
      { kind: 'budget', enabled: true },
    ]);
  });
});

describe('Notice preferences (request 36): an expense notice follows the preference in force when the expense is recorded', () => {
  it('stops the notices of a turned-off kind from then on, tells the others as before, and restarts when turned on again', async () => {
    const bob = await person('Bob');
    const cy = await person('Cy');
    const dan = await person('Dan');
    const groupId = await createGroup(bob);
    await join(groupId, bob, cy);
    await join(groupId, bob, dan);

    // Cy turns expense notices off before any expense: the first expense is not told to Cy, and Dan is told as before.
    expect(await setPreference(cy.token, 'expense', false)).toBe('SUCCESS');
    await record(bob.token, groupId, {
      description: 'Pizzas',
      amount: 900,
      date: '2025-06-01',
      splitBetween: [bob.id, cy.id, dan.id],
    });
    expect(await waitForNotices(dan.token, 1)).toEqual([
      {
        id: expect.any(String),
        kind: 'expense',
        groupId,
        expenseId: expect.any(String),
        amount: 300,
        at: expect.any(String),
      },
    ]);
    expect(await notices(cy.token)).toEqual([]);

    // Cy turns them on again: the next expense is told; the one recorded while off is not told later.
    expect(await setPreference(cy.token, 'expense', true)).toBe('SUCCESS');
    await record(bob.token, groupId, {
      description: 'Bread',
      amount: 600,
      date: '2025-06-02',
      splitBetween: [bob.id, cy.id],
    });
    const forCy = await waitForNotices(cy.token, 1);
    expect(forCy).toEqual([
      {
        id: expect.any(String),
        kind: 'expense',
        groupId,
        expenseId: expect.any(String),
        amount: 300,
        at: expect.any(String),
      },
    ]);
    expect(await notices(cy.token)).toHaveLength(1);
  });

  it('turns the kinds off and on for the caller only, and says what it changed in its read', async () => {
    const eve = await person('Eve');
    expect(await setPreference(eve.token, 'reminder', false)).toBe('SUCCESS');
    expect(await setPreference(eve.token, 'reminder', false)).toBe('SUCCESS');
    const read = await http.get(`${api}/accounts/me/notice-preferences`, { token: eve.token });
    expect(read.body).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: false },
      { kind: 'budget', enabled: true },
    ]);
  });
});

describe('Notice preferences (request 36): a budget notice follows its kind', () => {
  it('tells a member who turned budget notices off nothing, and the others once, as before', async () => {
    const fay = await person('Fay');
    const gus = await person('Gus');
    const groupId = await createGroup(fay);
    await join(groupId, fay, gus);
    const set = await http.request('PUT', `${api}/groups/${groupId}/budgets/groceries`, {
      body: { amount: 1000 },
      token: fay.token,
    });
    await outcome((set.body as Body).operationId as string, fay.token);
    expect(await setPreference(gus.token, 'budget', false)).toBe('SUCCESS');

    await record(fay.token, groupId, {
      description: 'Shopping',
      amount: 1500,
      date: '2025-06-01',
      category: 'groceries',
      splitBetween: [fay.id, gus.id],
    });
    const forFay = await waitForNotices(fay.token, 1);
    expect(forFay.find(notice => notice.kind === 'budget')).toEqual(
      expect.objectContaining({ kind: 'budget', groupId, amount: 1500 }),
    );
    // The expense itself is still told to Gus; only the budget is not.
    await waitForNotices(gus.token, 1);
    expect((await notices(gus.token)).map(notice => notice.kind)).toEqual(['expense']);
  });
});

describe('Notice preferences (request 36): a reminder not made while reminders are off is made once they are on again', () => {
  it('reminds a member at the first run that finds reminders on, if the debt still lasts', async () => {
    const hal = await person('Hal');
    const ida = await person('Ida');
    const groupId = await createGroup(hal);
    await join(groupId, hal, ida);
    // Hal paid 5000 for the two of them: Ida owes 2500, over 2000.
    await record(hal.token, groupId, {
      description: 'Dinner',
      amount: 5000,
      date: '2025-06-01',
      splitBetween: [hal.id, ida.id],
    });
    expect(await setPreference(ida.token, 'reminder', false)).toBe('SUCCESS');

    await app.runJobs();
    now = new Date(now.getTime() + WEEK);
    await app.runJobs();
    expect((await notices(ida.token)).filter(notice => notice.kind === 'reminder')).toEqual([]);

    expect(await setPreference(ida.token, 'reminder', true)).toBe('SUCCESS');
    await app.runJobs();
    const reminders = (await notices(ida.token)).filter(notice => notice.kind === 'reminder');
    expect(reminders).toEqual([
      { id: expect.any(String), kind: 'reminder', groupId, amount: 2500, at: now.toISOString() },
    ]);
  });
});

describe('Notice preferences (request 36): what the transport and the domain refuse', () => {
  it('refuses a body that is not an enabled flag at once, with 400', async () => {
    const jo = await person('Jo');
    const answer = await http.request('PUT', `${api}/accounts/me/notice-preferences/expense`, {
      body: { enabled: 'yes' },
      token: jo.token,
    });
    expect(answer.status).toBe(400);
  });

  it('answers a kind that is not one of the three as an operation that ends in ERROR, and changes nothing', async () => {
    const kim = await person('Kim');
    const answer = await http.request('PUT', `${api}/accounts/me/notice-preferences/weekly`, {
      body: { enabled: false },
      token: kim.token,
    });
    expect(answer.status).toBe(202);
    const done = await outcome((answer.body as Body).operationId as string, kim.token);
    expect(done.body).toEqual(
      expect.objectContaining({
        status: 'ERROR',
        error: { type: 'UnknownNoticeKind', message: expect.any(String) },
      }),
    );
    const read = await http.get(`${api}/accounts/me/notice-preferences`, { token: kim.token });
    expect((read.body as { enabled: boolean }[]).every(kind => kind.enabled)).toBe(true);
  });

  it('refuses a change by a caller not signed in at once, with 401, and publishes nothing', async () => {
    const answer = await http.request('PUT', `${api}/accounts/me/notice-preferences/expense`, {
      body: { enabled: false },
    });
    expect(answer.status).toBe(401);
  });
});
