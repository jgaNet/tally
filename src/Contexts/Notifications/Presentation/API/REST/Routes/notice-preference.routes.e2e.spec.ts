import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Notice preferences, end to end (request 36): the application booted in this process on a free port, spoken to over HTTP, every
 * answer held to api/36-notice-preferences.yaml by the client. One application per suite, shared by its tests in order.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
beforeAll(async () => {
  app = await createApplication({ jobsIntervalSeconds: 3600 });
  await app.start(0);
  http = apiClient(app.address);
});
afterAll(() => app.stop());

const PASSWORD = 'correct horse';
const SPENT = '2020-01-02';

/** Signs an account up and in, and answers its token and its id. */
async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

/** A group founded by `owner`, which each of `others` joins by an invitation: the group's id. */
async function groupWith(owner: { token: string }, others: { token: string }[]): Promise<string> {
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'The flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (created.body as { id: string }).id;
  for (const other of others) {
    const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
    const invitationId = (invitation.body as { id: string }).id;
    const joined = await http.request('POST', `/v1/invitations/${invitationId}/accept`, { token: other.token });
    expect(joined.status).toBe(201);
  }
  return groupId;
}

/** Records an expense paid by the holder of `token`, split equally between `between`: the expense's id, as the request answered it. */
async function record(groupId: string, token: string, description: string, amount: number, between: string[]) {
  const answer = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
    body: { description, amount, date: SPENT, splitBetween: between },
    token,
  });
  expect(answer.status).toBe(201);
  return (answer.body as { id: string }).id;
}

/** A moment for any reaction still on its way to land: what has not appeared by then was not made. */
const settle = () => new Promise(resolve => setTimeout(resolve, 300));

/** The notices of the holder of `token`, read again until they number `count`, for at most 3 seconds. */
async function noticesOnce(token: string, count: number): Promise<{ expenseId?: string }[]> {
  let notices: { expenseId?: string }[] = [];
  for (let attempt = 0; attempt < 120; attempt++) {
    const answer = await http.get('/v1/notices', { token });
    expect(answer.status).toBe(200);
    notices = answer.body as { expenseId?: string }[];
    if (notices.length >= count) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return notices;
}

describe('notice preferences (request 36)', () => {
  it('reads every kind on, in order, for a person who has never chosen; and a person reads only their own', async () => {
    const ann = await accountOf('ann.prefs@example.com', 'Ann');
    const ben = await accountOf('ben.prefs@example.com', 'Ben');

    const answer = await http.get('/v1/accounts/me/notice-preferences', { token: ann.token });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: true },
      { kind: 'budget', enabled: true },
    ]);

    await http.request('PUT', '/v1/accounts/me/notice-preferences/budget', {
      body: { enabled: false },
      token: ben.token,
    });
    const annAgain = await http.get('/v1/accounts/me/notice-preferences', { token: ann.token });
    expect(annAgain.body).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: true },
      { kind: 'budget', enabled: true },
    ]);
  });

  it('turns a kind off and on again, and reads each as it is', async () => {
    const cal = await accountOf('cal.prefs@example.com', 'Cal');

    const off = await http.request('PUT', '/v1/accounts/me/notice-preferences/reminder', {
      body: { enabled: false },
      token: cal.token,
    });
    expect(off.status).toBe(201);
    expect((await http.get('/v1/accounts/me/notice-preferences', { token: cal.token })).body).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: false },
      { kind: 'budget', enabled: true },
    ]);

    await http.request('PUT', '/v1/accounts/me/notice-preferences/reminder', {
      body: { enabled: true },
      token: cal.token,
    });
    expect((await http.get('/v1/accounts/me/notice-preferences', { token: cal.token })).body).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: true },
      { kind: 'budget', enabled: true },
    ]);
  });

  it('refuses a kind it does not make, a value that is not on or off, and a caller who is not signed in', async () => {
    const dot = await accountOf('dot.prefs@example.com', 'Dot');

    const unknownKind = await http.request('PUT', '/v1/accounts/me/notice-preferences/weekly', {
      body: { enabled: false },
      token: dot.token,
    });
    expect(unknownKind.status).toBe(400);

    const notBoolean = await http.request('PUT', '/v1/accounts/me/notice-preferences/expense', {
      body: { enabled: 'no' },
      token: dot.token,
    });
    expect(notBoolean.status).toBe(400);

    const anonymous = await http.request('PUT', '/v1/accounts/me/notice-preferences/expense', {
      body: { enabled: false },
    });
    expect(anonymous.status).toBe(401);
    expect((await http.get('/v1/accounts/me/notice-preferences')).status).toBe(401);

    expect((await http.get('/v1/accounts/me/notice-preferences', { token: dot.token })).body).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: true },
      { kind: 'budget', enabled: true },
    ]);
  });
});

describe('Ledger → Notifications', () => {
  it('makes no expense notice for a person from the moment they turn expense notices off, and makes them again once on', async () => {
    const bob = await accountOf('bob.prefs@example.com', 'Bob');
    const cy = await accountOf('cy.prefs@example.com', 'Cy');
    const dee = await accountOf('dee.prefs@example.com', 'Dee');
    const groupId = await groupWith(bob, [cy, dee]);

    await http.request('PUT', '/v1/accounts/me/notice-preferences/expense', {
      body: { enabled: false },
      token: cy.token,
    });
    const pizzas = await record(groupId, bob.token, 'Pizzas', 1000, [bob.id, cy.id, dee.id]);

    // Dee is told of the expense the request answered; Cy, who has turned expense notices off, is not.
    expect(await noticesOnce(dee.token, 1)).toEqual([expect.objectContaining({ expenseId: pizzas, amount: 333 })]);
    await settle();
    expect((await http.get('/v1/notices', { token: cy.token })).body).toEqual([]);

    await http.request('PUT', '/v1/accounts/me/notice-preferences/expense', {
      body: { enabled: true },
      token: cy.token,
    });
    const tea = await record(groupId, bob.token, 'Tea', 600, [bob.id, cy.id, dee.id]);

    // Cy is told of the expense made once they are on again, by the id that request answered; the one before is not made later.
    expect(await noticesOnce(cy.token, 1)).toEqual([expect.objectContaining({ expenseId: tea, amount: 200 })]);
    await settle();
    expect((await http.get('/v1/notices', { token: cy.token })).body).toHaveLength(1);
    expect(await noticesOnce(dee.token, 2)).toHaveLength(2);
  });
});
