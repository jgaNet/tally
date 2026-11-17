import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

// The application keeps what it knows in the file DATABASE_PATH names: this suite has a file of its own.
process.env.DATABASE_PATH = join(tmpdir(), `tally-groups-${randomUUID()}.db`);

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

const PASSWORD = 'a-good-password';

/** Signs up and signs in a fresh account, answering its token. */
async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

const createGroup = (token: string | undefined, body: unknown) =>
  http.request('POST', `${api}/groups`, { body, token });
const getGroup = (id: string, token?: string) => http.request('GET', `${api}/groups/${id}`, { token });
const myGroups = (token: string) => http.request('GET', `${api}/groups/mine`, { token });

describe('groups', () => {
  it('creates a group for a signed-in person, answering 201 with its id', async () => {
    const ada = await signedIn('ada@example.com', 'Ada');

    const created = await createGroup(ada.token, { name: 'Lisbon trip', currency: 'EUR' });

    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String) });
  });

  it('refuses a missing caller with 401, before anything is made', async () => {
    expect((await createGroup(undefined, { name: 'Flat', currency: 'EUR' })).status).toBe(401);
  });

  it('refuses what the domain refuses with 422, and a body of the wrong shape with 400', async () => {
    const ada = await signedIn('ada2@example.com', 'Ada');

    expect(await createGroup(ada.token, { name: '   ', currency: 'EUR' })).toMatchObject({
      status: 422,
      body: { type: 'InvalidGroupName' },
    });
    expect(await createGroup(ada.token, { name: 'Flat', currency: 'JPY' })).toMatchObject({
      status: 422,
      body: { type: 'InvalidCurrency' },
    });
    expect((await createGroup(ada.token, { name: 'Flat', currency: 978 })).status).toBe(400);
    expect((await createGroup(ada.token, { name: 'Flat' })).status).toBe(400);
  });

  it('answers the group to its owner, with its name, its currency and its owner', async () => {
    const ada = await signedIn('ada3@example.com', 'Ada');
    const { id } = (await createGroup(ada.token, { name: 'Flat', currency: 'GBP' })).body as { id: string };

    expect(await getGroup(id, ada.token)).toMatchObject({
      status: 200,
      body: { id, name: 'Flat', currency: 'GBP', ownerId: ada.id },
    });
  });

  it('does not show a group to anyone who is not its member: 404, as if it did not exist', async () => {
    const ada = await signedIn('ada4@example.com', 'Ada');
    const bob = await signedIn('bob4@example.com', 'Bob');
    const { id } = (await createGroup(ada.token, { name: 'Climbing', currency: 'CHF' })).body as { id: string };

    const notMine = await getGroup(id, bob.token);
    const unknown = await getGroup('00000000-0000-4000-8000-000000000000', bob.token);

    expect(notMine).toMatchObject({ status: 404, body: { type: 'NotFound' } });
    expect(unknown).toMatchObject({ status: 404, body: { type: 'NotFound' } });
    expect(notMine.body).toEqual(unknown.body);
  });

  it('answers 401 to a missing caller who reads a group', async () => {
    const ada = await signedIn('ada5@example.com', 'Ada');
    const { id } = (await createGroup(ada.token, { name: 'Club', currency: 'USD' })).body as { id: string };

    expect((await getGroup(id)).status).toBe(401);
  });

  it('lists my groups, the most recently created first, and only those I am a member of', async () => {
    const ada = await signedIn('ada6@example.com', 'Ada');
    const bob = await signedIn('bob6@example.com', 'Bob');
    const first = (await createGroup(ada.token, { name: 'First', currency: 'EUR' })).body as { id: string };
    const second = (await createGroup(ada.token, { name: 'Second', currency: 'AUD' })).body as { id: string };
    await createGroup(bob.token, { name: 'Bobs', currency: 'CAD' });

    const mine = await myGroups(ada.token);

    expect(mine.status).toBe(200);
    expect(mine.body).toEqual([
      { id: second.id, name: 'Second', currency: 'AUD', ownerId: ada.id },
      { id: first.id, name: 'First', currency: 'EUR', ownerId: ada.id },
    ]);
    expect(await myGroups(bob.token)).toMatchObject({
      status: 200,
      body: [{ name: 'Bobs', currency: 'CAD', ownerId: bob.id }],
    });
    expect((await myGroups(ada.token)).body).not.toContainEqual(expect.objectContaining({ name: 'Bobs' }));
  });

  it('keeps the groups and their members across a restart of the application', async () => {
    const ada = await signedIn('ada7@example.com', 'Ada');
    const { id } = (await createGroup(ada.token, { name: 'Kept', currency: 'EUR' })).body as { id: string };

    await app.stop();
    app = await createApplication();
    await app.start(0);
    http = apiClient(app.address);

    expect(await getGroup(id, ada.token)).toMatchObject({ status: 200, body: { id, name: 'Kept' } });
    expect((await myGroups(ada.token)).body).toContainEqual(expect.objectContaining({ id }));
  });
});
