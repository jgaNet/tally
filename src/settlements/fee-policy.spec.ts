import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, startFakeProvider, temporaryDatabaseUrl } from '../test-support';
import type { FakeProvider } from '../test-support';

describe('the fee policy of a group', () => {
  let app: Application;
  let databaseUrl: string;
  let provider: FakeProvider;

  beforeEach(async () => {
    databaseUrl = await temporaryDatabaseUrl();
    provider = await startFakeProvider();
    app = await createApplication({ databaseUrl, providerUrl: provider.url, providerTimeoutMs: 300 });
  });

  afterEach(async () => {
    await app.stop();
    await provider.close();
  });

  /** Ada owns a group that Grace joined: `groupId`, and both of them. */
  async function adaAndGrace() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const created = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat 4B', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    return { ada, grace, groupId };
  }

  const readPolicy = (token: string, groupId: string) => send(app, 'GET', `/groups/${groupId}/fee-policy`, { token });
  const setPolicy = (token: string, groupId: string, borneBy: unknown) =>
    send(app, 'PUT', `/groups/${groupId}/fee-policy`, { token, payload: { borneBy } });

  it('is the payee’s until the owner decides', async () => {
    const { ada, groupId } = await adaAndGrace();
    const response = await readPolicy(ada.token, groupId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ borneBy: 'payee' });
  });

  it('is decided by the owner, and read by every member', async () => {
    const { ada, grace, groupId } = await adaAndGrace();
    const set = await setPolicy(ada.token, groupId, 'shared');
    expect(set.statusCode).toBe(204);

    expect((await readPolicy(ada.token, groupId)).json()).toEqual({ borneBy: 'shared' });
    expect((await readPolicy(grace.token, groupId)).json()).toEqual({ borneBy: 'shared' });
  });

  it('is changed by no other member, who is refused and changes nothing', async () => {
    const { ada, grace, groupId } = await adaAndGrace();
    const response = await setPolicy(grace.token, groupId, 'payer');
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ type: 'NotPermitted' });
    expect((await readPolicy(ada.token, groupId)).json()).toEqual({ borneBy: 'payee' });
  });

  it('is not there for someone outside the group, who is told the group does not exist', async () => {
    const { ada, groupId } = await adaAndGrace();
    const outsider = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
    expect((await readPolicy(outsider.token, groupId)).statusCode).toBe(404);
    expect((await setPolicy(outsider.token, groupId, 'payer')).statusCode).toBe(404);
    expect((await readPolicy(ada.token, groupId)).json()).toEqual({ borneBy: 'payee' });
  });

  it('is one of payer, payee or shared', async () => {
    const { ada, groupId } = await adaAndGrace();
    const response = await setPolicy(ada.token, groupId, 'everyone');
    expect(response.statusCode).toBe(400);
    expect((await readPolicy(ada.token, groupId)).json()).toEqual({ borneBy: 'payee' });
  });

  it('is read only once the group is archived', async () => {
    const { ada, groupId } = await adaAndGrace();
    expect((await send(app, 'POST', `/groups/${groupId}/archive`, { token: ada.token })).statusCode).toBe(204);
    const response = await setPolicy(ada.token, groupId, 'payer');
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ type: 'GroupArchived' });
    expect((await readPolicy(ada.token, groupId)).json()).toEqual({ borneBy: 'payee' });
  });
});
