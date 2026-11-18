import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The groups, over HTTP: creating one, reading it, and listing one's own, on a database file of its own. The answers
 * are held to the API `api/` gives, through `apiClient()`.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_URL = await freshDatabaseUrl();
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

let accountCount = 0;
/** A signed-in person, with a fresh email, and their token. */
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

const createGroup = (token: string | undefined, body: Record<string, unknown>) =>
  http.request('POST', `${api}/groups`, { body, token });
const getGroup = (id: string, token?: string) => http.request('GET', `${api}/groups/${id}`, { token });
const myGroups = (token?: string) => http.request('GET', `${api}/groups/mine`, { token });

describe('creating a group', () => {
  it('creates the group and answers its id', async () => {
    const ada = await signedInPerson('Ada');
    const answer = await createGroup(ada.token, { name: 'Flat', currency: 'EUR' });
    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ id: expect.any(String) });
  });

  it('makes its creator the owner, and reads the group back as it was made', async () => {
    const ada = await signedInPerson('Grace');
    const { id } = (await createGroup(ada.token, { name: '  Trip to Lisbon ', currency: 'GBP' })).body as {
      id: string;
    };

    const answer = await getGroup(id, ada.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ id, name: 'Trip to Lisbon', currency: 'GBP', ownerId: ada.id });
  });

  it.each(['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'])('accepts the currency %s', async currency => {
    const ada = await signedInPerson('Currency');
    expect((await createGroup(ada.token, { name: 'Club', currency })).status).toBe(201);
  });

  it.each([
    ['a currency that is not one of the six', { currency: 'JPY' }],
    ['a name only of spaces', { name: '   ' }],
    ['a name of 61 characters', { name: 'a'.repeat(61) }],
  ])('refuses %s with 400', async (_label, change) => {
    const ada = await signedInPerson('Refused');
    const answer = await createGroup(ada.token, { name: 'Flat', currency: 'EUR', ...change });
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ type: expect.any(String), message: expect.any(String) });
  });

  it('refuses a body missing a field, or with a field of the wrong type, with 400', async () => {
    const ada = await signedInPerson('Shape');
    expect((await createGroup(ada.token, { name: 'Flat' })).status).toBe(400);
    expect((await createGroup(ada.token, { name: 'Flat', currency: 12 })).status).toBe(400);
  });

  it('refuses a request with no caller with 401, before anything is made', async () => {
    expect((await createGroup(undefined, { name: 'Flat', currency: 'EUR' })).status).toBe(401);
  });
});

describe('who sees a group', () => {
  it('does not show a group to someone who is not a member, as if it did not exist', async () => {
    const owner = await signedInPerson('Owner');
    const stranger = await signedInPerson('Stranger');
    const { id } = (await createGroup(owner.token, { name: 'Private', currency: 'USD' })).body as { id: string };

    const denied = await getGroup(id, stranger.token);
    const missing = await getGroup('00000000-0000-4000-8000-000000000000', stranger.token);
    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(denied.body).toEqual(missing.body);
  });

  it('refuses a read with no caller with 401', async () => {
    const owner = await signedInPerson('Anonymous');
    const { id } = (await createGroup(owner.token, { name: 'Closed', currency: 'CHF' })).body as { id: string };
    expect((await getGroup(id)).status).toBe(401);
    expect((await myGroups()).status).toBe(401);
  });
});

describe('my groups', () => {
  it('lists the groups the caller is a member of, the most recently created first', async () => {
    const ada = await signedInPerson('Lister');
    const other = await signedInPerson('Elsewhere');
    const first = (await createGroup(ada.token, { name: 'First', currency: 'EUR' })).body as { id: string };
    await createGroup(other.token, { name: 'Not mine', currency: 'EUR' });
    const second = (await createGroup(ada.token, { name: 'Second', currency: 'AUD' })).body as { id: string };

    const answer = await myGroups(ada.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { id: second.id, name: 'Second', currency: 'AUD', ownerId: ada.id },
      { id: first.id, name: 'First', currency: 'EUR', ownerId: ada.id },
    ]);
  });

  it('answers an empty list to someone who is in no group', async () => {
    const nobody = await signedInPerson('Nobody');
    expect(await myGroups(nobody.token)).toEqual({ status: 200, body: [], headers: expect.anything() });
  });
});
