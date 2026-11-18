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

describe("settlements in a member's statement", () => {
  let app: Application;
  let databaseUrl: string;
  let provider: FakeProvider;

  beforeEach(async () => {
    databaseUrl = await temporaryDatabaseUrl();
    provider = await startFakeProvider();
    app = await createApplication({
      databaseUrl,
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

  const dayBefore = (day: string, days = 1): string =>
    new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

  let scenarios = 0;
  /**
   * Ada and Grace, Grace owns the group. Grace paid 1000 two days ago, split between them: Ada owes 500.
   * Ada's statement, once she pays through the provider, is read by her token.
   */
  async function adaOwesGrace() {
    scenarios += 1;
    const ada = await signedUpAccount(app, { email: `ada${scenarios}@example.com` });
    const grace = await signedUpAccount(app, { email: `grace${scenarios}@example.com`, name: 'Grace' });
    const created = await send(app, 'POST', '/groups', {
      token: grace.token,
      payload: { name: 'Flat', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, grace.token, ada.token, groupId);
    await setPayoutAccount(app, grace.token, 'acct-grace');
    const expense = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: grace.token,
      payload: {
        description: 'Dinner',
        amount: 1000,
        date: dayBefore(todayInUtc(), 2),
        splitBetween: [ada.id, grace.id],
      },
    });
    expect(expense.statusCode).toBe(201);
    return { ada, grace, groupId, expenseId: expense.json<{ id: string }>().id };
  }

  async function askProvider(token: string, groupId: string, to: string, amount: number): Promise<string> {
    const asked = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
      token,
      payload: { to, amount },
    });
    expect(asked.statusCode).toBe(201);
    return asked.json<{ id: string }>().id;
  }

  async function statementOf(token: string, groupId: string, memberId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/members/${memberId}/statement`, { token });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it('leaves out a settlement through the provider that is pending, and one the provider failed', async () => {
    const { ada, grace, groupId } = await adaOwesGrace();
    await askProvider(ada.token, groupId, grace.id, 200);
    const failedId = await askProvider(ada.token, groupId, grace.id, 100);
    const paymentId = provider.payments[provider.payments.length - 1].id;
    expect((await webhook(paymentId, 'failed')).statusCode).toBe(204);

    const statement = await statementOf(ada.token, groupId, ada.id);
    expect(statement.entries.map((entry: { kind: string }) => entry.kind)).toEqual(['expense']);
    expect(statement.entries.map((entry: { settlementId?: string }) => entry.settlementId)).not.toContain(failedId);
    expect(statement.balance).toBe(-500);
  });

  it('lists a settlement through the provider from the day the provider says it is paid', async () => {
    const { ada, grace, groupId, expenseId } = await adaOwesGrace();
    const id = await askProvider(ada.token, groupId, grace.id, 300);
    const paymentId = provider.payments[provider.payments.length - 1].id;
    expect((await webhook(paymentId, 'succeeded')).statusCode).toBe(204);

    const statement = await statementOf(ada.token, groupId, ada.id);
    expect(statement.entries).toEqual([
      {
        kind: 'expense',
        expenseId,
        date: dayBefore(todayInUtc(), 2),
        description: 'Dinner',
        paid: 0,
        share: 500,
        balance: -500,
      },
      {
        kind: 'settlement',
        settlementId: id,
        date: todayInUtc(),
        description: 'Settlement through the provider',
        paid: 300,
        share: 0,
        balance: -200,
      },
    ]);
    expect(statement.balance).toBe(-200);
    // The payee's statement has the same settlement, as what it was paid.
    const forGrace = await statementOf(grace.token, groupId, grace.id);
    expect(forGrace.entries).toContainEqual(
      expect.objectContaining({ kind: 'settlement', settlementId: id, paid: 0, share: 300 }),
    );
  });

  it('keeps a settlement being refunded in the statement, and drops it once the provider says it is refunded', async () => {
    const { ada, grace, groupId } = await adaOwesGrace();
    const id = await askProvider(ada.token, groupId, grace.id, 300);
    const paymentId = provider.payments[provider.payments.length - 1].id;
    expect((await webhook(paymentId, 'succeeded')).statusCode).toBe(204);

    expect((await send(app, 'POST', `/settlements/${id}/refund`, { token: grace.token })).statusCode).toBe(204);
    let statement = await statementOf(ada.token, groupId, ada.id);
    expect(statement.entries.map((entry: { settlementId?: string }) => entry.settlementId)).toContain(id);
    expect(statement.balance).toBe(-200);

    expect((await webhook(paymentId, 'refunded')).statusCode).toBe(204);
    statement = await statementOf(ada.token, groupId, ada.id);
    expect(statement.entries.map((entry: { kind: string }) => entry.kind)).toEqual(['expense']);
    expect(statement.balance).toBe(-500);
    expect((await send(app, 'GET', `/groups/${groupId}/balances`, { token: ada.token })).json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ memberId: ada.id, balance: -500 })]),
    );
  });
});
