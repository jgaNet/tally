import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Groups, end to end: the application booted in this process on a free port, spoken to over HTTP, every answer
 * held to api/2-create-a-group.yaml by the client. One application per suite, shared by its tests in order.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});
afterAll(() => app.stop());

const PASSWORD = 'correct horse';

/** Signs an account up and in, and answers its token and its id. */
async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

const createGroup = (token: string | undefined, body: unknown) => http.request('POST', '/v1/groups', { body, token });
const getGroup = (id: string, token?: string) => http.get(`/v1/groups/${id}`, { token });
const myGroups = (token?: string) => http.get('/v1/groups/mine', { token });

describe('creating a group', () => {
  it('creates a group in a currency and answers its id at once', async () => {
    const ana = await accountOf('ana.groups@example.com', 'Ana');
    const answer = await createGroup(ana.token, { name: 'The flat', currency: 'EUR' });

    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ id: expect.any(String) });
  });

  it('trims the name it keeps', async () => {
    const ana = await accountOf('ana.trim@example.com', 'Ana');
    const created = await createGroup(ana.token, { name: '  Lisbon  ', currency: 'USD' });
    const read = await getGroup((created.body as { id: string }).id, ana.token);

    expect(read.body).toMatchObject({ name: 'Lisbon' });
  });

  it('refuses a name that is only spaces, or longer than 60 characters', async () => {
    const ana = await accountOf('ana.names@example.com', 'Ana');
    const blank = await createGroup(ana.token, { name: '    ', currency: 'EUR' });
    const long = await createGroup(ana.token, { name: 'x'.repeat(61), currency: 'EUR' });

    expect(blank.status).toBe(400);
    expect(blank.body).toMatchObject({ type: 'InvalidGroupName' });
    expect(long.status).toBe(400);
    expect(long.body).toMatchObject({ type: 'InvalidGroupName' });
  });

  it('refuses a currency that is not one of the six', async () => {
    const ana = await accountOf('ana.currency@example.com', 'Ana');
    const answer = await createGroup(ana.token, { name: 'Trip', currency: 'JPY' });

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ type: 'UnsupportedCurrency' });
  });

  it('refuses a caller who is not signed in, before anything else', async () => {
    const answer = await createGroup(undefined, { name: 'Ghost', currency: 'EUR' });

    expect(answer.status).toBe(401);
  });

  it('refuses a body missing a field, or with a field of the wrong type', async () => {
    const ana = await accountOf('ana.shape@example.com', 'Ana');
    const missing = await createGroup(ana.token, { name: 'Flat' });
    const wrongType = await createGroup(ana.token, { name: 'Flat', currency: 1 });

    expect(missing.status).toBe(400);
    expect(wrongType.status).toBe(400);
  });
});

describe('reading a group', () => {
  it('answers the owner the group, with the owner as its owner', async () => {
    const ana = await accountOf('ana.read@example.com', 'Ana');
    const { body } = await createGroup(ana.token, { name: 'Climbing club', currency: 'CHF' });
    const answer = await getGroup((body as { id: string }).id, ana.token);

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      id: (body as { id: string }).id,
      name: 'Climbing club',
      currency: 'CHF',
      ownerId: ana.id,
    });
  });

  it('does not show a group to someone who is not a member: it does not exist for them', async () => {
    const ana = await accountOf('ana.hidden@example.com', 'Ana');
    const ben = await accountOf('ben.hidden@example.com', 'Ben');
    const { body } = await createGroup(ana.token, { name: 'Private', currency: 'GBP' });
    const id = (body as { id: string }).id;

    const stranger = await getGroup(id, ben.token);
    const unknown = await getGroup('no-such-group', ben.token);

    expect(stranger.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(stranger.body).toEqual(unknown.body);
  });

  it('refuses a read with no token', async () => {
    const ana = await accountOf('ana.anon@example.com', 'Ana');
    const { body } = await createGroup(ana.token, { name: 'Anonymous read', currency: 'AUD' });

    const answer = await getGroup((body as { id: string }).id);

    expect(answer.status).toBe(401);
  });
});

describe('my groups', () => {
  it('lists the groups the caller is a member of, the most recently created first', async () => {
    const cara = await accountOf('cara.mine@example.com', 'Cara');
    const dan = await accountOf('dan.mine@example.com', 'Dan');
    const first = await createGroup(cara.token, { name: 'First', currency: 'EUR' });
    const second = await createGroup(cara.token, { name: 'Second', currency: 'USD' });
    await createGroup(dan.token, { name: 'Dan only', currency: 'EUR' });

    const answer = await myGroups(cara.token);

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { id: (second.body as { id: string }).id, name: 'Second', currency: 'USD', ownerId: cara.id },
      { id: (first.body as { id: string }).id, name: 'First', currency: 'EUR', ownerId: cara.id },
    ]);
  });

  it('answers an empty list to a caller in no group', async () => {
    const eve = await accountOf('eve.mine@example.com', 'Eve');

    const answer = await myGroups(eve.token);

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([]);
  });

  it('refuses a read with no token', async () => {
    const answer = await myGroups();

    expect(answer.status).toBe(401);
  });
});
