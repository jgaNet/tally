import { createHmac } from 'node:crypto';
import type { InjectOptions } from 'fastify';
import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import {
  type FakeProvider,
  type FakeReceiptsStore,
  joinThroughInvitation,
  send,
  setPayoutAccount,
  signedUpAccount,
  startFakeProvider,
  startFakeReceiptsStore,
  temporaryDatabaseUrl,
} from '../test-support';

const SECRET = 'shared-secret';

/** The `day` of the month `months` from the current one (UTC), as `YYYY-MM-DD`. */
function dayOfMonth(months: number, day: number): string {
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, day));
  return month.toISOString().slice(0, 10);
}

/** A JPEG, the bytes a receipt starts with, and nothing else that matters. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe('an archived group', () => {
  let app: Application;
  let provider: FakeProvider;
  let receipts: FakeReceiptsStore;

  beforeEach(async () => {
    provider = await startFakeProvider();
    receipts = await startFakeReceiptsStore();
    app = await createApplication({
      databaseUrl: await temporaryDatabaseUrl(),
      providerUrl: provider.url,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 300,
      receiptsUrl: receipts.url,
      receiptsTimeoutMs: 300,
    });
  });

  afterEach(async () => {
    await app.stop();
    await provider.close();
    await receipts.close();
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

  /**
   * A group with everything a group can hold, archived with every balance 0. Ada owns it and Grace is a member; Lin is
   * outside it, with an invitation of Ada's that is not yet accepted. Ada pays 1000 split between her and Grace, which has
   * a receipt; Grace pays her 500 through the provider, which says it succeeded; Ada has a template, a budget, a recurring
   * expense. Each of them is kept, so each can be changed or refused after the archiving.
   */
  async function archivedGroup() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const lin = await signedUpAccount(app, { email: 'lin@example.com', name: 'Lin' });
    const created = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat 4B', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);

    const recorded = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ada.token,
      payload: { description: 'Dinner', amount: 1000, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
    });
    expect(recorded.statusCode).toBe(201);
    const expenseId = recorded.json<{ id: string }>().id;
    const attached = await app.server.inject({
      method: 'PUT',
      url: `/v1/expenses/${expenseId}/receipt`,
      headers: { authorization: `Bearer ${ada.token}`, 'content-type': 'application/octet-stream' },
      payload: JPEG,
    });
    expect(attached.statusCode).toBe(204);

    await setPayoutAccount(app, ada.token, 'acct-ada');
    const asked = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
      token: grace.token,
      payload: { to: ada.id, amount: 500 },
    });
    expect(asked.statusCode).toBe(201);
    const settlementId = asked.json<{ id: string }>().id;
    const paymentId = provider.payments[provider.payments.length - 1].id;
    expect((await webhook(paymentId, 'succeeded')).statusCode).toBe(204);

    const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ada.token });
    const invitationId = invitation.json<{ id: string }>().id;
    const template = await send(app, 'POST', `/groups/${groupId}/templates`, {
      token: ada.token,
      payload: { name: 'Even', splitBetween: [ada.id, grace.id] },
    });
    const templateId = template.json<{ id: string }>().id;
    expect(
      (await send(app, 'PUT', `/groups/${groupId}/budgets/food`, { token: ada.token, payload: { amount: 20000 } }))
        .statusCode,
    ).toBe(204);
    const recurring = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: ada.token,
      payload: {
        description: 'Rent share',
        amount: 300,
        startsOn: dayOfMonth(1, 5),
        category: 'rent',
        splitBetween: [ada.id, grace.id],
      },
    });
    const recurringId = recurring.json<{ id: string }>().id;

    expect((await send(app, 'POST', `/groups/${groupId}/archive`, { token: ada.token })).statusCode).toBe(204);
    return { ada, grace, lin, groupId, expenseId, settlementId, paymentId, invitationId, templateId, recurringId };
  }

  /** What the group holds, as its owner reads it. Nothing in it changes unless this does. */
  async function contents(scene: Awaited<ReturnType<typeof archivedGroup>>) {
    const { ada, lin, groupId, expenseId, settlementId, invitationId } = scene;
    const get = async (path: string, token = ada.token) => {
      const response = await send(app, 'GET', path, { token });
      return { statusCode: response.statusCode, body: response.json() };
    };
    return {
      group: await get(`/groups/${groupId}`),
      members: await get(`/groups/${groupId}/members`),
      balances: await get(`/groups/${groupId}/balances`),
      expenses: await get(`/groups/${groupId}/expenses`),
      expense: await get(`/expenses/${expenseId}`),
      receipt: await get(`/expenses/${expenseId}/receipt`),
      settlements: await get(`/groups/${groupId}/settlements`),
      settlement: await get(`/settlements/${settlementId}`),
      templates: await get(`/groups/${groupId}/templates`),
      budgets: await get(`/groups/${groupId}/budgets`),
      recurring: await get(`/groups/${groupId}/recurring`),
      recurringOne: await get(`/recurring/${scene.recurringId}`),
      invitation: await get(`/invitations/${invitationId}`, lin.token),
      joinedByLin: await get(`/groups/${groupId}`, lin.token),
    };
  }

  it('refuses every change by the one rule, and changes nothing', async () => {
    const scene = await archivedGroup();
    const { ada, grace, lin, groupId, expenseId, settlementId, invitationId, templateId, recurringId } = scene;
    const before = await contents(scene);

    // The provider says the paid payment was refunded: signed as it sends it, and so it would change the balances.
    const refundedWebhook = `{ "id": "wh-refunded", "paymentId": "${scene.paymentId}", "status": "refunded", "at": "2026-11-17T10:00:00Z" }`;
    const attempts: { name: string; request: InjectOptions }[] = [
      {
        name: 'record an expense',
        request: {
          method: 'POST',
          url: `/v1/groups/${groupId}/expenses`,
          headers: { authorization: `Bearer ${ada.token}` },
          payload: { description: 'Tea', amount: 300, date: todayInUtc(), splitBetween: [ada.id] },
        },
      },
      {
        name: 'edit an expense',
        request: {
          method: 'PUT',
          url: `/v1/expenses/${expenseId}`,
          headers: { authorization: `Bearer ${ada.token}` },
          payload: {
            description: 'Dinner again',
            amount: 900,
            date: todayInUtc(),
            splitBetween: [ada.id, grace.id],
            version: 1,
          },
        },
      },
      {
        name: 'delete an expense',
        request: {
          method: 'DELETE',
          url: `/v1/expenses/${expenseId}`,
          headers: { authorization: `Bearer ${ada.token}` },
        },
      },
      {
        name: 'attach a receipt',
        request: {
          method: 'PUT',
          url: `/v1/expenses/${expenseId}/receipt`,
          headers: { authorization: `Bearer ${ada.token}`, 'content-type': 'application/octet-stream' },
          payload: JPEG,
        },
      },
      {
        name: 'record a settlement in cash',
        request: {
          method: 'POST',
          url: `/v1/groups/${groupId}/settlements/cash`,
          headers: { authorization: `Bearer ${ada.token}` },
          payload: { from: grace.id, amount: 100 },
        },
      },
      {
        name: 'ask for a settlement through the provider',
        request: {
          method: 'POST',
          url: `/v1/groups/${groupId}/settlements/provider`,
          headers: { authorization: `Bearer ${grace.token}` },
          payload: { to: ada.id, amount: 100 },
        },
      },
      {
        name: 'refund a settlement through the provider',
        request: {
          method: 'POST',
          url: `/v1/settlements/${settlementId}/refund`,
          headers: { authorization: `Bearer ${ada.token}` },
        },
      },
      {
        name: 'take the provider’s word that a payment was refunded',
        request: {
          method: 'POST',
          url: '/v1/provider/webhooks',
          headers: { 'content-type': 'application/json', 'provider-signature': sign(refundedWebhook) },
          payload: refundedWebhook,
        },
      },
      {
        name: 'create an invitation',
        request: {
          method: 'POST',
          url: `/v1/groups/${groupId}/invitations`,
          headers: { authorization: `Bearer ${ada.token}` },
        },
      },
      {
        name: 'join by an invitation',
        request: {
          method: 'POST',
          url: `/v1/invitations/${invitationId}/accept`,
          headers: { authorization: `Bearer ${lin.token}` },
        },
      },
      {
        name: 'leave the group',
        request: {
          method: 'POST',
          url: `/v1/groups/${groupId}/leave`,
          headers: { authorization: `Bearer ${grace.token}` },
        },
      },
      {
        name: 'set up a recurring expense',
        request: {
          method: 'POST',
          url: `/v1/groups/${groupId}/recurring`,
          headers: { authorization: `Bearer ${ada.token}` },
          payload: { description: 'Gym', amount: 40, startsOn: dayOfMonth(1, 9), splitBetween: [ada.id, grace.id] },
        },
      },
      {
        name: 'stop a recurring expense',
        request: {
          method: 'DELETE',
          url: `/v1/recurring/${recurringId}`,
          headers: { authorization: `Bearer ${ada.token}` },
        },
      },
      {
        name: 'set a budget',
        request: {
          method: 'PUT',
          url: `/v1/groups/${groupId}/budgets/travel`,
          headers: { authorization: `Bearer ${ada.token}` },
          payload: { amount: 5000 },
        },
      },
      {
        name: 'remove a budget',
        request: {
          method: 'DELETE',
          url: `/v1/groups/${groupId}/budgets/food`,
          headers: { authorization: `Bearer ${ada.token}` },
        },
      },
      {
        name: 'save a template',
        request: {
          method: 'POST',
          url: `/v1/groups/${groupId}/templates`,
          headers: { authorization: `Bearer ${ada.token}` },
          payload: { name: 'Odd', splitBetween: [ada.id] },
        },
      },
      {
        name: 'replace a template',
        request: {
          method: 'PUT',
          url: `/v1/templates/${templateId}`,
          headers: { authorization: `Bearer ${ada.token}` },
          payload: { name: 'Even', splitBetween: [ada.id] },
        },
      },
      {
        name: 'remove a template',
        request: {
          method: 'DELETE',
          url: `/v1/templates/${templateId}`,
          headers: { authorization: `Bearer ${ada.token}` },
        },
      },
      {
        name: 'archive it again',
        request: {
          method: 'POST',
          url: `/v1/groups/${groupId}/archive`,
          headers: { authorization: `Bearer ${ada.token}` },
        },
      },
    ];

    const answers: { name: string; statusCode: number; type?: string }[] = [];
    for (const { name, request } of attempts) {
      const response = await app.server.inject(request);
      answers.push({
        name,
        statusCode: response.statusCode,
        type: response.body === '' ? undefined : response.json<{ type?: string }>().type,
      });
    }

    // Every change is refused by the one rule. The webhook is the provider's word, which the rule refuses too.
    expect(answers).toEqual(attempts.map(({ name }) => ({ name, statusCode: 409, type: 'GroupArchived' })));
    expect(await contents(scene)).toEqual(before);
  });

  it('answers every member as before, the group, its members, balances, expenses, receipts, statements and the rest', async () => {
    const { ada, grace, groupId, expenseId, settlementId } = await archivedGroup();
    const reads = [
      `/groups/${groupId}`,
      `/groups/${groupId}/members`,
      `/groups/${groupId}/balances`,
      `/groups/${groupId}/expenses`,
      `/expenses/${expenseId}`,
      `/expenses/${expenseId}/receipt`,
      `/groups/${groupId}/members/${ada.id}/statement`,
      `/groups/${groupId}/settlements`,
      `/settlements/${settlementId}`,
      `/groups/${groupId}/settlements/suggested`,
      `/groups/${groupId}/budgets`,
      `/groups/${groupId}/templates`,
      `/groups/${groupId}/recurring`,
    ];
    for (const path of reads) {
      const response = await send(app, 'GET', path, { token: grace.token });
      expect({ path, statusCode: response.statusCode }).toEqual({ path, statusCode: 200 });
    }
    const group = (await send(app, 'GET', `/groups/${groupId}`, { token: grace.token })).json<{ archivedAt: string }>();
    expect(group.archivedAt).toEqual(expect.any(String));
    const mine = (await send(app, 'GET', '/groups/mine', { token: grace.token })).json<
      { id: string; archivedAt: string }[]
    >();
    expect(mine.find(entry => entry.id === groupId)?.archivedAt).toBe(group.archivedAt);
  });

  it('is not read by one who is not a member, as before', async () => {
    const { lin, groupId } = await archivedGroup();
    expect((await send(app, 'GET', `/groups/${groupId}`, { token: lin.token })).statusCode).toBe(404);
  });
});
