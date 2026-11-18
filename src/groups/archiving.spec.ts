import { createHmac } from 'node:crypto';
import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import {
  type FakeProvider,
  joinThroughInvitation,
  send,
  setPayoutAccount,
  signedUpAccount,
  startFakeProvider,
  temporaryDatabaseUrl,
} from '../test-support';

const SECRET = 'shared-secret';
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;

describe('archiving a group', () => {
  let app: Application;
  let provider: FakeProvider;

  beforeEach(async () => {
    provider = await startFakeProvider();
    app = await createApplication({
      databaseUrl: await temporaryDatabaseUrl(),
      providerUrl: provider.url,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 300,
    });
  });

  afterEach(async () => {
    await app.stop();
    await provider.close();
  });

  const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');

  let counter = 0;
  /** The provider's signed webhook about `paymentId` saying `status`. */
  function webhook(paymentId: string, status: string) {
    counter += 1;
    const body = `{ "id": "wh-${counter}", "paymentId": "${paymentId}", "status": "${status}", "at": "2026-11-17T10:00:00Z" }`;
    return app.server.inject({
      method: 'POST',
      url: '/v1/provider/webhooks',
      headers: { 'content-type': 'application/json', 'provider-signature': sign(body) },
      payload: body,
    });
  }

  async function createdGroup(token: string): Promise<string> {
    const response = await send(app, 'POST', '/groups', { token, payload: { name: 'Flat 4B', currency: 'EUR' } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  /** Ada owns a group Grace joins, and Ada pays 1000 split between them: Grace owes Ada 500. */
  async function groupWithAnExpense() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const groupId = await createdGroup(ada.token);
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    const expense = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ada.token,
      payload: { description: 'Dinner', amount: 1000, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
    });
    expect(expense.statusCode).toBe(201);
    return { ada, grace, groupId };
  }

  /** The group of `groupWithAnExpense`, once Grace has paid Ada her 500 in cash: every balance is 0. */
  async function settledGroup() {
    const scene = await groupWithAnExpense();
    const paid = await send(app, 'POST', `/groups/${scene.groupId}/settlements/cash`, {
      token: scene.ada.token,
      payload: { from: scene.grace.id, amount: 500 },
    });
    expect(paid.statusCode).toBe(201);
    return scene;
  }

  /**
   * The group of `groupWithAnExpense`, once Grace has paid Ada her 500 through the provider and the provider says it
   * succeeded: every balance is 0, and the settlement is paid.
   */
  async function settledThroughProvider() {
    const scene = await groupWithAnExpense();
    await setPayoutAccount(app, scene.ada.token, 'acct-ada');
    const asked = await send(app, 'POST', `/groups/${scene.groupId}/settlements/provider`, {
      token: scene.grace.token,
      payload: { to: scene.ada.id, amount: 500 },
    });
    expect(asked.statusCode).toBe(201);
    const id = asked.json<{ id: string }>().id;
    const paymentId = provider.payments[provider.payments.length - 1].id;
    expect((await webhook(paymentId, 'succeeded')).statusCode).toBe(204);
    return { ...scene, id, paymentId };
  }

  const archive = (token: string, groupId: string) => send(app, 'POST', `/groups/${groupId}/archive`, { token });

  async function readGroup(token: string, groupId: string) {
    return send(app, 'GET', `/groups/${groupId}`, { token });
  }

  it('is archived by its owner once every balance is 0, and reads as archived from then on', async () => {
    const { ada, grace, groupId } = await settledGroup();
    const before = (await readGroup(ada.token, groupId)).json<Record<string, unknown>>();
    expect(before).not.toHaveProperty('archivedAt');

    const started = Date.now();
    const response = await archive(ada.token, groupId);
    expect(response.statusCode).toBe(204);
    const finished = Date.now();

    const group = (await readGroup(grace.token, groupId)).json<{ archivedAt: string }>();
    expect(group).toEqual({ ...before, archivedAt: expect.stringMatching(ISO_TIME) });
    expect(Date.parse(group.archivedAt)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(group.archivedAt)).toBeLessThanOrEqual(finished);

    const mine = (await send(app, 'GET', '/groups/mine', { token: grace.token })).json<{ id: string }[]>();
    expect(mine.find(entry => entry.id === groupId)).toEqual(group);
  });

  it('is refused while a balance is not 0, and nothing changes', async () => {
    const { ada, groupId } = await groupWithAnExpense();
    const response = await archive(ada.token, groupId);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ type: 'BalancesNotSettled', message: expect.any(String) });
    expect((await readGroup(ada.token, groupId)).json() as object).not.toHaveProperty('archivedAt');
  });

  it('is refused while a refund through the provider is waiting, and nothing changes', async () => {
    const { ada, grace, groupId, id } = await settledThroughProvider();
    // Ada, who was paid, asks for the refund: it is refunding until the provider says it is refunded.
    expect((await send(app, 'POST', `/settlements/${id}/refund`, { token: ada.token })).statusCode).toBe(204);

    const response = await archive(ada.token, groupId);
    expect(response.statusCode).toBe(409);
    expect(response.json().type).toBe('PaymentPending');
    expect((await readGroup(grace.token, groupId)).json()).not.toHaveProperty('archivedAt');
  });

  it('is refused while a payment through the provider is pending, the balance still owing it', async () => {
    const { ada, grace, groupId } = await groupWithAnExpense();
    await setPayoutAccount(app, ada.token, 'acct-ada');
    const asked = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
      token: grace.token,
      payload: { to: ada.id, amount: 500 },
    });
    expect(asked.statusCode).toBe(201);

    const response = await archive(ada.token, groupId);
    expect(response.statusCode).toBe(409);
    expect((await readGroup(ada.token, groupId)).json()).not.toHaveProperty('archivedAt');
  });

  it('is refused to a member who is not its owner with 403, and to anyone outside it with 404', async () => {
    const { ada, grace, groupId } = await settledGroup();
    const lin = await signedUpAccount(app, { email: 'lin@example.com', name: 'Lin' });

    const byMember = await archive(grace.token, groupId);
    expect(byMember.statusCode).toBe(403);
    expect(byMember.json().type).toBe('NotPermitted');

    const byStranger = await archive(lin.token, groupId);
    expect(byStranger.statusCode).toBe(404);
    expect(byStranger.json().type).toBe('NotFound');

    expect((await readGroup(ada.token, groupId)).json()).not.toHaveProperty('archivedAt');
  });

  it('is refused again once archived, and keeps the time it was first archived', async () => {
    const { ada, groupId } = await settledGroup();
    expect((await archive(ada.token, groupId)).statusCode).toBe(204);
    const first = (await readGroup(ada.token, groupId)).json<{ archivedAt: string }>().archivedAt;

    const again = await archive(ada.token, groupId);
    expect(again.statusCode).toBe(409);
    expect(again.json().type).toBe('GroupArchived');
    expect((await readGroup(ada.token, groupId)).json<{ archivedAt: string }>().archivedAt).toBe(first);
  });
});
