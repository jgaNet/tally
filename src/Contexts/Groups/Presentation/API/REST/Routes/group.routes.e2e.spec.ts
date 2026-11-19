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

type Body = Record<string, unknown>;

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
  const email = `${name.toLowerCase()}-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group as a client does: `202`, then the operation followed to its outcome. */
async function createGroup(token: string | undefined, body: Body) {
  const answer = await http.request('POST', `${api}/groups`, { body, token });
  if (answer.status !== 202) return { answer, body: undefined };
  return { answer, body: (await outcome((answer.body as Body).operationId as string, token)).body as Body };
}

describe('creating a group', () => {
  it('answers 202, and the operation succeeds with the id of the new group', async () => {
    const alice = await person('Alice');
    const { answer, body } = await createGroup(alice.token, { name: 'Flat', currency: 'EUR' });
    expect(answer.status).toBe(202);
    expect(body).toMatchObject({ status: 'SUCCESS', result: { id: expect.any(String) } });
  });

  it.each(['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'])('accepts the currency %s', async currency => {
    const alice = await person('Currency');
    const { body } = await createGroup(alice.token, { name: `Group ${currency}`, currency });
    expect(body).toMatchObject({ status: 'SUCCESS' });
  });

  it.each([
    ['an empty name', { name: '', currency: 'EUR' }, 'InvalidGroupName'],
    ['a name of spaces', { name: '   ', currency: 'EUR' }, 'InvalidGroupName'],
    ['a name of 61 characters', { name: 'a'.repeat(61), currency: 'EUR' }, 'InvalidGroupName'],
    ['a currency not in the list', { name: 'Trip', currency: 'XXX' }, 'InvalidCurrency'],
    ['a currency in lower case', { name: 'Trip', currency: 'eur' }, 'InvalidCurrency'],
  ])('refuses %s, behind the 202', async (_, body, type) => {
    const alice = await person('Refused');
    const result = await createGroup(alice.token, body);
    expect(result.answer.status).toBe(202);
    expect(result.body).toMatchObject({ status: 'ERROR', error: { type, message: expect.any(String) } });
  });

  it('accepts a name of 60 characters', async () => {
    const alice = await person('Long');
    const { body } = await createGroup(alice.token, { name: 'a'.repeat(60), currency: 'CHF' });
    expect(body).toMatchObject({ status: 'SUCCESS' });
  });

  it.each([
    ['a missing field', { name: 'Trip' }],
    ['a field of the wrong type', { name: 'Trip', currency: 978 }],
    ['a null field', { name: null, currency: 'EUR' }],
  ])('refuses %s at once with 400', async (_, body) => {
    const alice = await person('Shape');
    expect((await http.request('POST', `${api}/groups`, { body, token: alice.token })).status).toBe(400);
  });

  it('refuses a caller who is not signed in at once with 401, and publishes nothing', async () => {
    const answer = await http.request('POST', `${api}/groups`, { body: { name: 'Anonymous', currency: 'EUR' } });
    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({ message: 'Authentication required' });
  });
});

describe('reading a group', () => {
  it('answers its id, name, currency and owner to one of its members, the owner included', async () => {
    const alice = await person('Reader');
    const { body } = await createGroup(alice.token, { name: 'Lisbon', currency: 'USD' });
    const id = (body as { result: { id: string } }).result.id;
    const answer = await http.get(`${api}/groups/${id}`, { token: alice.token });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ id, name: 'Lisbon', currency: 'USD', ownerId: alice.id });
  });

  it('answers 404 to anyone who is not a member, exactly as for a group that does not exist', async () => {
    const alice = await person('Hidden');
    const bob = await person('Outsider');
    const { body } = await createGroup(alice.token, { name: 'Secret', currency: 'GBP' });
    const id = (body as { result: { id: string } }).result.id;

    const notMember = await http.get(`${api}/groups/${id}`, { token: bob.token });
    const unknown = await http.get(`${api}/groups/no-such-group`, { token: bob.token });
    expect(notMember.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(notMember.body).toEqual(unknown.body);
  });

  it('refuses no token at once with 401, on the group and on the list', async () => {
    expect((await http.get(`${api}/groups/anything`)).status).toBe(401);
    expect((await http.get(`${api}/groups/mine`)).status).toBe(401);
  });
});

describe('my groups', () => {
  it('lists the groups one is a member of, the most recently created first, and no one else’s', async () => {
    const alice = await person('Lister');
    const bob = await person('Other');
    const first = await createGroup(alice.token, { name: 'First', currency: 'EUR' });
    const second = await createGroup(alice.token, { name: 'Second', currency: 'AUD' });
    const theirs = await createGroup(bob.token, { name: 'Theirs', currency: 'CAD' });

    const mine = await http.get(`${api}/groups/mine`, { token: alice.token });
    expect(mine.status).toBe(200);
    const ids = [
      (first.body as { result: { id: string } }).result.id,
      (second.body as { result: { id: string } }).result.id,
    ];
    expect(mine.body).toEqual([
      { id: ids[1], name: 'Second', currency: 'AUD', ownerId: alice.id },
      { id: ids[0], name: 'First', currency: 'EUR', ownerId: alice.id },
    ]);

    const bobs = await http.get(`${api}/groups/mine`, { token: bob.token });
    expect(bobs.body).toEqual([
      { id: (theirs.body as { result: { id: string } }).result.id, name: 'Theirs', currency: 'CAD', ownerId: bob.id },
    ]);
  });

  it('answers an empty list to a signed-in person in no group', async () => {
    const carol = await person('Solo');
    const mine = await http.get(`${api}/groups/mine`, { token: carol.token });
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual([]);
  });
});
