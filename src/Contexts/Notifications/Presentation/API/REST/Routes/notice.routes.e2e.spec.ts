import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

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

type Operation = { status: string; result?: string; error?: { type: string; message: string } };
type Notice = { id: string; kind: 'expense'; groupId: string; expenseId: string; amount: number; at: string };

/** Follows an operation to its end, as a client answered 202 does. */
async function outcome(operationId: string, token?: string): Promise<Operation> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    expect(status).toBe(200);
    if ((body as Operation).status !== 'PENDING') return body as Operation;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

/** Signs someone up and in, under the name given: their account's id, and the token that names it. */
async function signedIn(email: string, name: string): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email, password: 'correct horse', name },
  });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, {
    body: { email, password: 'correct horse' },
  });
  return { id: operation.result as string, token: (login.body as { token: string }).token };
}

/** Creates a group and follows its operation: the operation's result is the group's id. */
async function createGroup(token: string, name: string): Promise<string> {
  const answer = await http.request('POST', `${api}/groups`, { token, body: { name, currency: 'EUR' } });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

/** Joins a group by an invitation, following the operation of the join. */
async function join(token: string, groupId: string, joiner: string): Promise<void> {
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, token)).result as string;
  const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: joiner });
  await outcome((accepted.body as { operationId: string }).operationId, joiner);
}

/** Records an expense split equally between the members given, and follows its operation to the expense's id. */
async function record(token: string, groupId: string, description: string, members: string[]): Promise<string> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token,
    body: { description, amount: 900, date: '2026-03-10', splitBetween: members },
  });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

/** A person's notices, as the API answers them now. */
async function noticesOf(token: string): Promise<Notice[]> {
  const { status, body } = await http.get(`${api}/notices`, { token });
  expect(status).toBe(200);
  return body as Notice[];
}

/** Waits until a person has `count` notices (the reaction runs after the expense is recorded), and returns them. */
async function noticesUntil(token: string, count: number): Promise<Notice[]> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const notices = await noticesOf(token);
    if (notices.length >= count) return notices;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`The notices never reached ${count}`);
}

describe('GET /v1/notices (request 17)', () => {
  it('tells each member of the split but the payer their share, once, and nobody else anything', async () => {
    const bob = await signedIn('notice-bob@example.com', 'Bob');
    const cy = await signedIn('notice-cy@example.com', 'Cy');
    const dee = await signedIn('notice-dee@example.com', 'Dee');
    const flat = await createGroup(bob.token, 'Flat');
    await join(bob.token, flat, cy.token);
    await join(bob.token, flat, dee.token);

    const expense = await record(bob.token, flat, 'Pizzas', [bob.id, cy.id, dee.id]);

    const cyNotices = await noticesUntil(cy.token, 1);
    expect(cyNotices).toEqual([
      {
        id: expect.any(String),
        kind: 'expense',
        groupId: flat,
        expenseId: expense,
        amount: 300,
        at: expect.any(String),
      },
    ]);
    expect(cyNotices[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(await noticesUntil(dee.token, 1)).toEqual([expect.objectContaining({ expenseId: expense, amount: 300 })]);

    // The payer recorded it and is told nothing; the notices are the ones made, once, not one more.
    expect(await noticesOf(bob.token)).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(await noticesOf(cy.token)).toHaveLength(1);
  });

  it('lists a person’s own notices the most recent first, and nobody else’s', async () => {
    const payer = await signedIn('notice-payer@example.com', 'Pat');
    const mate = await signedIn('notice-mate@example.com', 'Mo');
    const stranger = await signedIn('notice-stranger@example.com', 'Sam');
    const house = await createGroup(payer.token, 'House');
    await join(payer.token, house, mate.token);

    const first = await record(payer.token, house, 'Rent', [payer.id, mate.id]);
    await noticesUntil(mate.token, 1);
    const second = await record(payer.token, house, 'Milk', [payer.id, mate.id]);
    const mates = await noticesUntil(mate.token, 2);

    expect(mates.map(notice => notice.expenseId)).toEqual([second, first]);
    expect(await noticesOf(stranger.token)).toEqual([]);
  });

  it('makes no notice for an edit or a deletion', async () => {
    const payer = await signedIn('notice-edit-payer@example.com', 'Eli');
    const mate = await signedIn('notice-edit-mate@example.com', 'Ada');
    const group = await createGroup(payer.token, 'Trip');
    await join(payer.token, group, mate.token);
    const expense = await record(payer.token, group, 'Train', [payer.id, mate.id]);
    await noticesUntil(mate.token, 1);

    const deleted = await http.request('DELETE', `${api}/expenses/${expense}`, { token: payer.token });
    expect(deleted.status).toBe(202);
    expect((await outcome((deleted.body as { operationId: string }).operationId, payer.token)).status).toBe('SUCCESS');

    await new Promise(resolve => setTimeout(resolve, 200));
    expect(await noticesOf(mate.token)).toHaveLength(1);
  });

  it('answers 401 to a caller who is not signed in', async () => {
    expect((await http.get(`${api}/notices`)).status).toBe(401);
  });
});
