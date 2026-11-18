import { randomUUID } from 'node:crypto';
import { Application } from './app';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };

describe("who bears the provider's fee in a group", () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let adaToken: string;
  let graceToken: string;
  let outsiderToken: string;
  let groupId: string;

  /** Signs the account up and in, and answers its id and token. */
  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  const policyOf = (token: string, id = groupId) => call(app, 'GET', `/groups/${id}/fee-policy`, { token });
  const setPolicy = (borneBy: unknown, token = adaToken, id = groupId) =>
    call(app, 'PUT', `/groups/${id}/fee-policy`, { body: { borneBy }, token });

  beforeEach(async () => {
    database = temporaryDatabase();
    app = await startApplication(database.url);
    adaToken = (await accountOf(ada)).token;
    graceToken = (await accountOf(grace)).token;
    outsiderToken = (await accountOf(outsiderAccount)).token;
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    expect((await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: graceToken })).status).toBe(
      204,
    );
  });

  afterEach(async () => {
    await app.stop();
    await database.remove();
  });

  it('is the payee’s, until the owner decides', async () => {
    expect(await policyOf(graceToken)).toEqual({ status: 200, body: { borneBy: 'payee' } });
    expect(await policyOf(adaToken)).toEqual({ status: 200, body: { borneBy: 'payee' } });
  });

  it.each(['payer', 'shared', 'payee'])('is set by the owner to %s, and read back as set', async borneBy => {
    expect((await setPolicy(borneBy)).status).toBe(204);
    expect(await policyOf(graceToken)).toEqual({ status: 200, body: { borneBy } });
  });

  it('is read by the members of the group, and answers 404 to an account outside it and to a group that does not exist', async () => {
    expect((await policyOf(graceToken)).status).toBe(200);
    expect((await policyOf(outsiderToken)).status).toBe(404);
    expect((await policyOf(adaToken, randomUUID())).status).toBe(404);
  });

  it('is refused to a member who is not the owner, and changes nothing', async () => {
    const answer = await setPolicy('payer', graceToken);
    expect(answer.status).toBe(403);
    expect(answer.body.type).toBe('NotAllowed');
    expect(await policyOf(adaToken)).toEqual({ status: 200, body: { borneBy: 'payee' } });
  });

  it('answers 404 to an account outside the group, and changes nothing', async () => {
    expect((await setPolicy('payer', outsiderToken)).status).toBe(404);
    expect((await policyOf(adaToken)).body).toEqual({ borneBy: 'payee' });
  });

  it('refuses a bearer that is not payer, payee or shared, and changes nothing', async () => {
    const answer = await setPolicy('both');
    expect(answer.status).toBe(422);
    expect(answer.body.type).toBe('InvalidFeeBearer');
    expect((await policyOf(adaToken)).body).toEqual({ borneBy: 'payee' });
  });

  it('refuses a request without a bearer', async () => {
    const answer = await call(app, 'PUT', `/groups/${groupId}/fee-policy`, { body: {}, token: adaToken });
    expect(answer.status).toBe(400);
    expect(answer.body.type).toBe('InvalidRequest');
  });

  it('answers 401 to a read without a token', async () => {
    expect((await call(app, 'GET', `/groups/${groupId}/fee-policy`)).status).toBe(401);
  });

  it('refuses a change to an archived group, which is read only, and still reads its policy', async () => {
    const solo = (await call(app, 'POST', '/groups', { body: { name: 'Solo', currency: 'EUR' }, token: adaToken })).body
      .id;
    expect((await call(app, 'POST', `/groups/${solo}/archive`, { token: adaToken })).status).toBe(204);
    const answer = await setPolicy('payer', adaToken, solo);
    expect(answer.status).toBe(409);
    expect(answer.body.type).toBe('GroupArchived');
    expect((await policyOf(adaToken, solo)).body).toEqual({ borneBy: 'payee' });
  });
});
