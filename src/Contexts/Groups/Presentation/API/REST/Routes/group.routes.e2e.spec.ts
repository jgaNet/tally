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
type Group = { id: string; name: string; currency: string; ownerId: string };

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

/** Signs someone up and in: their account's id, and the token that names it. */
async function signedIn(email: string): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email, password: 'correct horse', name: 'Alice' },
  });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, {
    body: { email, password: 'correct horse' },
  });
  return { id: operation.result as string, token: (login.body as { token: string }).token };
}

/** Creates a group and follows its operation: the operation's result is the group's id. */
async function createGroup(token: string | undefined, name: string, currency = 'EUR'): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups`, { token, body: { name, currency } });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

describe('groups', () => {
  it('creates a group owned by its creator, who reads it and finds it in their list', async () => {
    const alice = await signedIn('alice@example.com');

    const operation = await createGroup(alice.token, 'Lisbon trip', 'EUR');
    expect(operation).toMatchObject({ status: 'SUCCESS', result: expect.any(String) });

    const read = await http.get(`${api}/groups/${operation.result}`, { token: alice.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ id: operation.result, name: 'Lisbon trip', currency: 'EUR', ownerId: alice.id });

    const mine = await http.get(`${api}/groups/mine`, { token: alice.token });
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual([{ id: operation.result, name: 'Lisbon trip', currency: 'EUR', ownerId: alice.id }]);
  });

  it('refuses the values a group may not have, on its operation', async () => {
    const alice = await signedIn('dana@example.com');
    const refusals: [string, string, string][] = [
      ['   ', 'EUR', 'InvalidGroupName'],
      ['x'.repeat(61), 'EUR', 'InvalidGroupName'],
      ['Flat', 'JPY', 'InvalidCurrency'],
    ];
    for (const [name, currency, type] of refusals) {
      const operation = await createGroup(alice.token, name, currency);
      expect(operation).toMatchObject({ status: 'ERROR', error: { type, message: expect.any(String) } });
    }
  });

  it('hides a group from anyone who is not a member, as if it did not exist', async () => {
    const alice = await signedIn('erin@example.com');
    const bob = await signedIn('frank@example.com');
    const group = await createGroup(alice.token, 'Climbing club');

    const stranger = await http.get(`${api}/groups/${group.result}`, { token: bob.token });
    const missing = await http.get(`${api}/groups/00000000-0000-4000-8000-000000000000`, { token: bob.token });

    expect(stranger.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(stranger.body).toEqual(missing.body);
    expect((await http.get(`${api}/groups/mine`, { token: bob.token })).body).not.toContainEqual(
      expect.objectContaining({ id: group.result }),
    );
  });

  it('answers 401 to a caller who is not signed in, for a create, a read and the list', async () => {
    const alice = await signedIn('gina@example.com');
    const group = await createGroup(alice.token, 'Flat');

    expect((await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' } })).status).toBe(401);
    expect((await http.get(`${api}/groups/${group.result}`)).status).toBe(401);
    expect((await http.get(`${api}/groups/mine`)).status).toBe(401);
  });

  it('lists my groups the most recently created first', async () => {
    const hugo = await signedIn('hugo@example.com');
    const first = await createGroup(hugo.token, 'Flat');
    const second = await createGroup(hugo.token, 'Climbing club');

    const mine = (await http.get(`${api}/groups/mine`, { token: hugo.token })).body as Group[];

    expect(mine.map(group => group.id)).toEqual([second.result, first.result]);
  });

  it('refuses a body of the wrong shape with 400, before anything is published', async () => {
    const alice = await signedIn('ivy@example.com');

    const answer = await http.request('POST', `${api}/groups`, {
      token: alice.token,
      body: { name: 42, currency: 'EUR' },
    });

    expect(answer.status).toBe(400);
  });
});
