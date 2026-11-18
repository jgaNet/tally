import { type Application, createApplication } from './app';
import { ensureDatabase, send, signedUpAccount, testDirectory, type TestDirectory } from './test-helpers';

interface Member {
  id: string;
  token: string;
}

describe('who bears the provider fee', () => {
  let directory: TestDirectory;
  let app: Application;

  beforeEach(async () => {
    directory = testDirectory();
    await ensureDatabase(directory.databaseUrl);
    app = await createApplication({ databaseUrl: directory.databaseUrl });
    await app.start(0);
  });

  afterEach(async () => {
    await app.stop();
    await directory.remove();
  });

  /** Bob's group, which Ann joined: Bob is its owner, Ann a member. */
  async function group(): Promise<{ bob: Member; ann: Member; groupId: string }> {
    const bob = await signedUpAccount(app, { email: 'bob@example.org', name: 'Bob' });
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const created = await send(app, 'POST', '/groups', { token: bob.token, body: { name: 'Flat', currency: 'EUR' } });
    const groupId = (created.body as { id: string }).id;
    const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: bob.token });
    const accepted = await send(app, 'POST', `/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: ann.token,
    });
    if (accepted.status !== 204) throw new Error(`accept answered ${accepted.status}`);
    return { bob, ann, groupId };
  }

  function readPolicy(token: string, groupId: string) {
    return send(app, 'GET', `/groups/${groupId}/fee-policy`, { token });
  }

  function setPolicy(token: string, groupId: string, borneBy: unknown) {
    return send(app, 'PUT', `/groups/${groupId}/fee-policy`, { token, body: { borneBy } });
  }

  it('is the payee, until the owner decides', async () => {
    const { bob, ann, groupId } = await group();
    expect(await readPolicy(bob.token, groupId)).toEqual({ status: 200, body: { borneBy: 'payee' } });
    // A member reads it too.
    expect(await readPolicy(ann.token, groupId)).toEqual({ status: 200, body: { borneBy: 'payee' } });
  });

  it('is set by the owner to payer, payee or shared, and read back by every member', async () => {
    const { bob, ann, groupId } = await group();
    for (const borneBy of ['payer', 'shared', 'payee']) {
      expect((await setPolicy(bob.token, groupId, borneBy)).status).toBe(204);
      expect(await readPolicy(bob.token, groupId)).toEqual({ status: 200, body: { borneBy } });
      expect(await readPolicy(ann.token, groupId)).toEqual({ status: 200, body: { borneBy } });
    }
  });

  it('refuses a member who is not the owner, and changes nothing', async () => {
    const { bob, ann, groupId } = await group();
    expect(await setPolicy(ann.token, groupId, 'payer')).toEqual({
      status: 403,
      body: expect.objectContaining({ error: 'NotOwner' }),
    });
    expect(await readPolicy(bob.token, groupId)).toEqual({ status: 200, body: { borneBy: 'payee' } });
  });

  it('refuses a value that is not payer, payee or shared, and changes nothing', async () => {
    const { bob, groupId } = await group();
    await setPolicy(bob.token, groupId, 'shared');
    for (const borneBy of ['both', 'PAYER', '']) {
      expect(await setPolicy(bob.token, groupId, borneBy)).toEqual({
        status: 422,
        body: expect.objectContaining({ error: 'FeeBearerIsUnsupported' }),
      });
    }
    // Not even a string is a bearer: the shape is refused as a bad request.
    expect((await setPolicy(bob.token, groupId, null)).status).toBe(400);
    expect((await setPolicy(bob.token, groupId, 3)).status).toBe(400);
    expect(await readPolicy(bob.token, groupId)).toEqual({ status: 200, body: { borneBy: 'shared' } });
  });

  it('refuses a change without borneBy as a bad request', async () => {
    const { bob, groupId } = await group();
    const reply = await send(app, 'PUT', `/groups/${groupId}/fee-policy`, { token: bob.token, body: {} });
    expect(reply.status).toBe(400);
  });

  it('refuses a non-member as if the group did not exist', async () => {
    const { groupId } = await group();
    const stranger = await signedUpAccount(app, { email: 'cy@example.org', name: 'Cy' });
    expect((await readPolicy(stranger.token, groupId)).status).toBe(404);
    expect((await setPolicy(stranger.token, groupId, 'payer')).status).toBe(404);
  });

  it('refuses a member who has left as if the group did not exist', async () => {
    const { bob, ann, groupId } = await group();
    expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: ann.token })).status).toBe(204);
    expect((await readPolicy(ann.token, groupId)).status).toBe(404);
    expect((await setPolicy(ann.token, groupId, 'payer')).status).toBe(404);
    expect(await readPolicy(bob.token, groupId)).toEqual({ status: 200, body: { borneBy: 'payee' } });
  });

  it('refuses a change to an archived group, and reads it as it was', async () => {
    const { bob, groupId } = await group();
    expect((await send(app, 'POST', `/groups/${groupId}/archive`, { token: bob.token })).status).toBe(204);
    expect(await setPolicy(bob.token, groupId, 'payer')).toEqual({
      status: 409,
      body: expect.objectContaining({ error: 'GroupIsArchived' }),
    });
    expect(await readPolicy(bob.token, groupId)).toEqual({ status: 200, body: { borneBy: 'payee' } });
  });

  it('refuses a request without a token', async () => {
    const { groupId } = await group();
    expect((await send(app, 'GET', `/groups/${groupId}/fee-policy`)).status).toBe(401);
  });
});
