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

describe('leaving a group (request 9)', () => {
  const leave = (id: string, token?: string) => http.request('POST', `${api}/groups/${id}/leave`, { token });
  const members = (id: string, token: string) => http.request('GET', `${api}/groups/${id}/members`, { token });

  /** Invites the member by the owner's link, and the joiner accepts it. */
  async function join(groupId: string, owner: string, joiner: string): Promise<void> {
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: joiner,
    });
  }

  it('lets a member with a balance of 0 leave, answering 204; the group is then not theirs', async () => {
    const ada = await signedIn('leave-ada@example.com', 'Ada');
    const bob = await signedIn('leave-bob@example.com', 'Bob');
    const { id } = (await createGroup(ada.token, { name: 'Flat', currency: 'EUR' })).body as { id: string };
    await join(id, ada.token, bob.token);

    expect((await leave(id, bob.token)).status).toBe(204);

    expect(await getGroup(id, bob.token)).toMatchObject({ status: 404, body: { type: 'NotFound' } });
    expect((await myGroups(bob.token)).body).not.toContainEqual(expect.objectContaining({ id }));
    expect((await members(id, ada.token)).body).toEqual([expect.objectContaining({ memberId: ada.id, role: 'owner' })]);
  });

  it('refuses the owner, who stays in the group: 422, OwnerCannotLeave', async () => {
    const ada = await signedIn('leave-owner@example.com', 'Ada');
    const { id } = (await createGroup(ada.token, { name: 'Stays', currency: 'EUR' })).body as { id: string };

    expect(await leave(id, ada.token)).toMatchObject({ status: 422, body: { type: 'OwnerCannotLeave' } });
    expect(await getGroup(id, ada.token)).toMatchObject({ status: 200 });
  });

  it('answers a group the caller is not a member of as if it did not exist, and a missing caller 401', async () => {
    const ada = await signedIn('leave-ada2@example.com', 'Ada');
    const eve = await signedIn('leave-eve@example.com', 'Eve');
    const { id } = (await createGroup(ada.token, { name: 'Closed', currency: 'EUR' })).body as { id: string };

    expect(await leave(id, eve.token)).toMatchObject({ status: 404, body: { type: 'NotFound' } });
    expect((await leave(id)).status).toBe(401);
  });

  it('lets a former member join again by an invitation: last of the members, as a new member', async () => {
    const ada = await signedIn('leave-ada3@example.com', 'Ada');
    const bob = await signedIn('leave-bob3@example.com', 'Bob');
    const cy = await signedIn('leave-cy3@example.com', 'Cy');
    const { id } = (await createGroup(ada.token, { name: 'Again', currency: 'EUR' })).body as { id: string };
    await join(id, ada.token, bob.token);
    await join(id, ada.token, cy.token);
    expect((await leave(id, bob.token)).status).toBe(204);

    await join(id, ada.token, bob.token);

    expect((await members(id, ada.token)).body).toEqual([
      expect.objectContaining({ memberId: ada.id, role: 'owner' }),
      expect.objectContaining({ memberId: cy.id, role: 'member' }),
      expect.objectContaining({ memberId: bob.id, role: 'member' }),
    ]);
    expect(await getGroup(id, bob.token)).toMatchObject({ status: 200 });
  });
});

describe('archiving a group (request 27)', () => {
  const archive = (id: string, token?: string) => http.request('POST', `${api}/groups/${id}/archive`, { token });
  const leave = (id: string, token?: string) => http.request('POST', `${api}/groups/${id}/leave`, { token });
  const invite = (id: string, token: string) => http.request('POST', `${api}/groups/${id}/invitations`, { token });
  const accept = (invitationId: string, token: string) =>
    http.request('POST', `${api}/invitations/${invitationId}/accept`, { token });
  const members = (id: string, token: string) => http.request('GET', `${api}/groups/${id}/members`, { token });
  const record = (id: string, token: string, body: unknown) =>
    http.request('POST', `${api}/groups/${id}/expenses`, { body, token });

  /** A group whose owner has invited the joiner, who has joined it. */
  async function groupWithJoiner(tag: string) {
    const ada = await signedIn(`archive-ada-${tag}@example.com`, 'Ada');
    const bob = await signedIn(`archive-bob-${tag}@example.com`, 'Bob');
    const { id } = (await createGroup(ada.token, { name: 'Flat', currency: 'EUR' })).body as { id: string };
    const invitation = await invite(id, ada.token);
    await accept((invitation.body as { id: string }).id, bob.token);
    return { ada, bob, id };
  }

  it('is archived by its owner, answering 204, and reads archivedAt; another member is refused 403', async () => {
    const { ada, bob, id } = await groupWithJoiner('ok');

    expect(await archive(id, bob.token)).toMatchObject({ status: 403, body: { type: 'NotAllowed' } });
    expect((await archive(id, ada.token)).status).toBe(204);

    const read = (await getGroup(id, ada.token)).body as { archivedAt?: string };
    expect(read.archivedAt).toEqual(expect.any(String));
    expect((await myGroups(bob.token)).body).toContainEqual(
      expect.objectContaining({ id, archivedAt: read.archivedAt }),
    );
  });

  it('refuses to archive while a balance is not 0, and answers a non-member as if the group did not exist', async () => {
    const { ada, bob, id } = await groupWithJoiner('balance');
    const cy = await signedIn('archive-cy-balance@example.com', 'Cy');
    await record(id, ada.token, {
      description: 'Dinner',
      amount: 1000,
      date: '2026-01-15',
      splitBetween: [ada.id, bob.id],
    });

    expect(await archive(id, ada.token)).toMatchObject({ status: 422, body: { type: 'BalancesNotZero' } });
    expect(await archive(id, cy.token)).toMatchObject({ status: 404, body: { type: 'NotFound' } });
    expect((await getGroup(id, ada.token)).body).not.toHaveProperty('archivedAt');
  });

  it('refuses every change in an archived group by GroupArchived, and still answers its members', async () => {
    const { ada, bob, id } = await groupWithJoiner('read-only');
    const cy = await signedIn('archive-cy-read-only@example.com', 'Cy');
    const invitation = (await invite(id, ada.token)).body as { id: string };
    expect((await archive(id, ada.token)).status).toBe(204);

    expect(await archive(id, ada.token)).toMatchObject({ status: 422, body: { type: 'GroupArchived' } });
    expect(await accept(invitation.id, cy.token)).toMatchObject({ status: 422, body: { type: 'GroupArchived' } });
    expect(await invite(id, ada.token)).toMatchObject({ status: 422, body: { type: 'GroupArchived' } });
    expect(await leave(id, bob.token)).toMatchObject({ status: 422, body: { type: 'GroupArchived' } });
    expect(
      await record(id, ada.token, { description: 'Late', amount: 500, date: '2026-01-16', splitBetween: [ada.id] }),
    ).toMatchObject({ status: 422, body: { type: 'GroupArchived' } });

    expect((await members(id, bob.token)).body).toEqual([
      expect.objectContaining({ memberId: ada.id, role: 'owner' }),
      expect.objectContaining({ memberId: bob.id, role: 'member' }),
    ]);
    expect(await getGroup(id, bob.token)).toMatchObject({ status: 200 });
  });
});
