import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabaseUrl } from '../test-support';

describe('the administrators suspend and reinstate an account', () => {
  let app: Application;

  beforeEach(async () => {
    app = await createApplication({ databaseUrl: await temporaryDatabaseUrl(), adminEmails: 'Boss@Example.com' });
  });

  afterEach(async () => {
    await app.stop();
  });

  const boss = () => signedUpAccount(app, { email: 'boss@example.com', name: 'Boss' });
  const suspend = (token: string | undefined, id: string) =>
    send(app, 'PUT', `/admin/accounts/${id}/suspension`, { token });
  const reinstate = (token: string | undefined, id: string) =>
    send(app, 'DELETE', `/admin/accounts/${id}/suspension`, { token });
  const log = (token: string) => send(app, 'GET', '/admin/log', { token });

  /** Ada and Grace in a group that Grace made, with an expense of Grace's and a cash settlement of Ada's to her. */
  async function groupWithMoney() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const created = await send(app, 'POST', '/groups', {
      token: grace.token,
      payload: { name: 'Flat', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, grace.token, ada.token, groupId);
    const recorded = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: grace.token,
      payload: { description: 'Dinner', amount: 1000, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
    });
    expect(recorded.statusCode).toBe(201);
    const cash = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
      token: grace.token,
      payload: { from: ada.id, amount: 200 },
    });
    expect(cash.statusCode).toBe(201);
    return { ada, grace, groupId };
  }

  /** What the members of a group read of it, as the members read it: every answer about its money. */
  async function groupAsItIs(token: string, groupId: string) {
    const paths = ['', '/members', '/balances', '/expenses', '/settlements', '/settlements/suggested', '/audit'];
    return Promise.all(
      paths.map(async path => (await send(app, 'GET', `/groups/${groupId}${path}`, { token })).json()),
    );
  }

  it('suspends an account and reinstates it, each answering 204', async () => {
    const administrator = await boss();
    const ada = await signedUpAccount(app);
    expect((await suspend(administrator.token, ada.id)).statusCode).toBe(204);
    expect((await reinstate(administrator.token, ada.id)).statusCode).toBe(204);
  });

  it('logs each suspension and reinstatement, by the administrator, the account as its subject, the oldest first', async () => {
    const administrator = await boss();
    const ada = await signedUpAccount(app);
    await suspend(administrator.token, ada.id);
    await reinstate(administrator.token, ada.id);

    const entries = (await log(administrator.token)).json<
      { id: string; at: string; by: string; action: string; subjectId: string }[]
    >();
    expect(entries.map(entry => Object.keys(entry).sort())).toEqual([
      ['action', 'at', 'by', 'id', 'subjectId'],
      ['action', 'at', 'by', 'id', 'subjectId'],
    ]);
    expect(entries.map(({ by, action, subjectId }) => ({ by, action, subjectId }))).toEqual([
      { by: administrator.id, action: 'suspended', subjectId: ada.id },
      { by: administrator.id, action: 'reinstated', subjectId: ada.id },
    ]);
    expect(entries[0].at <= entries[1].at).toBe(true);
  });

  it('changes nothing, and is no entry, when an account already suspended is suspended again, or one not suspended is reinstated', async () => {
    const administrator = await boss();
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    expect((await reinstate(administrator.token, grace.id)).statusCode).toBe(204);
    expect((await suspend(administrator.token, ada.id)).statusCode).toBe(204);
    expect((await suspend(administrator.token, ada.id)).statusCode).toBe(204);
    expect((await log(administrator.token)).json<{ action: string }[]>().map(entry => entry.action)).toEqual([
      'suspended',
    ]);

    expect((await reinstate(administrator.token, ada.id)).statusCode).toBe(204);
    expect((await reinstate(administrator.token, ada.id)).statusCode).toBe(204);
    expect((await log(administrator.token)).json<{ action: string }[]>().map(entry => entry.action)).toEqual([
      'suspended',
      'reinstated',
    ]);
  });

  it('is refused to anyone who is not an administrator with 403, and changes nothing', async () => {
    const administrator = await boss();
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    for (const member of [ada, grace]) {
      for (const response of [await suspend(member.token, grace.id), await reinstate(member.token, grace.id)]) {
        expect(response.statusCode).toBe(403);
        expect(response.json().type).toBe('NotAdministrator');
      }
    }
    expect((await log(administrator.token)).json()).toEqual([]);
    // The account was not suspended by them: a suspension by the administrator is the first entry.
    await suspend(administrator.token, grace.id);
    expect((await log(administrator.token)).json<{ action: string }[]>()).toHaveLength(1);
  });

  it('is answered 401 to a request with no token', async () => {
    const ada = await signedUpAccount(app);
    expect((await suspend(undefined, ada.id)).statusCode).toBe(401);
    expect((await reinstate(undefined, ada.id)).statusCode).toBe(401);
  });

  it('is refused for an account that does not exist with 404, and changes nothing', async () => {
    const administrator = await boss();
    expect((await suspend(administrator.token, 'no-such-account')).statusCode).toBe(404);
    expect((await reinstate(administrator.token, 'no-such-account')).statusCode).toBe(404);
    expect((await log(administrator.token)).json()).toEqual([]);
  });

  it('writes nothing in any group, when an account is suspended or reinstated', async () => {
    const administrator = await boss();
    const { ada, grace, groupId } = await groupWithMoney();
    const before = await groupAsItIs(grace.token, groupId);

    await suspend(administrator.token, ada.id);
    expect(await groupAsItIs(grace.token, groupId)).toEqual(before);
    expect(await groupAsItIs(ada.token, groupId)).toEqual(before);

    await reinstate(administrator.token, ada.id);
    expect(await groupAsItIs(grace.token, groupId)).toEqual(before);

    // Each is in the administrators' log, and nowhere else.
    expect((await log(administrator.token)).json<{ action: string }[]>().map(entry => entry.action)).toEqual([
      'suspended',
      'reinstated',
    ]);
  });
});
