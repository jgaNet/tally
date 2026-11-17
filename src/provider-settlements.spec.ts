import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { type Application, createApplication } from './app';
import { openDatabase } from './database';
import { send, signedUpAccount, testDirectory, type TestDirectory } from './test-helpers';

const SECRET = 'shared with the provider';

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** The answer a fake provider gives to one payment request. */
interface ProviderAnswer {
  status: number;
  body?: unknown;
  /** Sent as the body instead of `body`, as it is. */
  text?: string;
  /** Waits this long before answering. */
  delayMs?: number;
}

/** A payment request the fake provider received. */
interface ProviderCall {
  method: string | undefined;
  path: string | undefined;
  body: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** The signature the provider puts on a webhook: HMAC-SHA256 of its body, in lowercase hexadecimal. */
function signed(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('paying through the provider', () => {
  let directory: TestDirectory;
  let app: Application;
  let db: DatabaseSync;
  let provider: Server;
  let providerUrl: string;
  let calls: ProviderCall[];
  let answerWith: (reference: string) => ProviderAnswer;
  let nextPayment: number;
  /** Applications started by a test beyond `app`, stopped after it. */
  const extra: Application[] = [];

  /** A payment the fake provider answers as created: `201 { id, payUrl }`, unless a test says otherwise. */
  function createdPayment(): ProviderAnswer {
    const n = nextPayment++;
    return { status: 201, body: { id: `pay_${n}`, payUrl: `https://pay.example.org/${n}` } };
  }

  beforeEach(async () => {
    directory = testDirectory();
    calls = [];
    nextPayment = 1;
    answerWith = () => createdPayment();
    provider = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => (raw += chunk));
      request.on('end', async () => {
        const body: unknown = raw === '' ? undefined : JSON.parse(raw);
        calls.push({ method: request.method, path: request.url, body });
        const answer = answerWith((body as { reference: string }).reference);
        if (answer.delayMs) await sleep(answer.delayMs);
        try {
          response.writeHead(answer.status, { 'content-type': 'application/json' });
          response.end(answer.text ?? (answer.body === undefined ? '' : JSON.stringify(answer.body)));
        } catch {
          // The caller gave up on the answer already.
        }
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    app = await createApplication({
      databasePath: directory.databasePath,
      providerUrl,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 200,
    });
    await app.start(0);
    // A second connection to the same file, to count what was stored.
    db = openDatabase(directory.databasePath);
  });

  afterEach(async () => {
    db.close();
    for (const other of extra.splice(0)) await other.stop();
    await app.stop();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    provider.closeAllConnections();
    directory.remove();
  });

  /** Creates a group as `token`'s account and answers its id. */
  async function createGroup(token: string): Promise<string> {
    const reply = await send(app, 'POST', '/groups', { token, body: { name: 'Trip', currency: 'EUR' } });
    if (reply.status !== 201) throw new Error(`create answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** Makes the account of `joinerToken` a member of `groupId`, through an invitation its owner creates. */
  async function join(ownerToken: string, groupId: string, joinerToken: string): Promise<void> {
    const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ownerToken });
    const id = (invitation.body as { id: string }).id;
    const accepted = await send(app, 'POST', `/invitations/${id}/accept`, { token: joinerToken });
    if (accepted.status !== 204) throw new Error(`accept answered ${accepted.status}`);
  }

  /** Ann creates a group with Ben, and Ann pays 3000 split equally: Ben owes Ann 1500. Answers the ids. */
  async function annAndBenOwing1500() {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const groupId = await createGroup(ann.token);
    await join(ann.token, groupId, ben.token);
    const expense = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Dinner', amount: 3000, date: utcDay(0), splitBetween: [ann.id, ben.id] },
    });
    if (expense.status !== 201) throw new Error(`record answered ${expense.status}`);
    return { ann, ben, groupId };
  }

  /** Asks the provider for a payment of `amount` from `payerToken`'s account to `to`. */
  async function askToPay(payerToken: string, groupId: string, to: string, amount: number) {
    return send(app, 'POST', `/groups/${groupId}/settlements/provider`, { token: payerToken, body: { to, amount } });
  }

  /** Settles in cash, recorded by `payeeToken`'s account, paid by `from`. */
  async function settleInCash(payeeToken: string, groupId: string, from: string, amount: number) {
    return send(app, 'POST', `/groups/${groupId}/settlements/cash`, { token: payeeToken, body: { from, amount } });
  }

  /** The balances of `groupId`, read as `token`'s account, as a map from member to balance. */
  async function balancesAs(token: string, groupId: string): Promise<Record<string, number>> {
    const reply = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    const rows = reply.body as { memberId: string; balance: number }[];
    return Object.fromEntries(rows.map(row => [row.memberId, row.balance]));
  }

  /** The suggested settlements of `groupId`, read as `token`'s account. */
  async function suggestionsAs(token: string, groupId: string) {
    const reply = await send(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token });
    return reply.body as { from: string; to: string; amount: number }[];
  }

  /** Sends a webhook with `body` as its exact bytes, and `signature` as its `Provider-Signature` when given. */
  async function postWebhook(body: string, signature?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (signature !== undefined) headers['provider-signature'] = signature;
    const response = await fetch(`${app.address}/${app.apiPrefix}/provider/webhooks`, {
      method: 'POST',
      headers,
      body,
    });
    return { status: response.status };
  }

  /** The webhook the provider sends about `paymentId` with `status`, as text, signed by the provider. */
  function webhookAbout(paymentId: string, status: string): { body: string; signature: string } {
    const body = JSON.stringify({ id: `evt_${paymentId}_${status}`, paymentId, status, at: new Date().toISOString() });
    return { body, signature: signed(body) };
  }

  /** The settlement with `id`, read as `token`'s account. */
  async function readSettlement(token: string, id: string) {
    return send(app, 'GET', `/settlements/${id}`, { token });
  }

  /** The webhook the provider sends about `paymentId` with `status` under the event id `eventId`, signed. */
  function webhookWithId(eventId: string, paymentId: string, status: string): { body: string; signature: string } {
    const body = JSON.stringify({ id: eventId, paymentId, status, at: new Date().toISOString() });
    return { body, signature: signed(body) };
  }

  /** Sends `webhook` to `server` and answers its status: what the provider gets back from that server. */
  async function deliver(server: Application, webhook: { body: string; signature: string }): Promise<number> {
    const response = await fetch(`${server.address}/${server.apiPrefix}/provider/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'provider-signature': webhook.signature },
      body: webhook.body,
    });
    return response.status;
  }

  /** Starts an application on the file of this test, as Tally starts again after it was stopped. */
  async function startApplicationOnFile(): Promise<Application> {
    const started = await createApplication({
      databasePath: directory.databasePath,
      providerUrl,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 200,
    });
    await started.start(0);
    return started;
  }

  function settlementCount(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM settlements').get() as { n: number }).n;
  }

  it('asks the provider for a payment referenced by the settlement, in the group’s currency, and keeps it pending with its payUrl', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const asked = await askToPay(ben.token, groupId, ann.id, 1000);
    expect(asked.status).toBe(201);
    const id = (asked.body as { id: string }).id;
    expect(calls).toEqual([
      { method: 'POST', path: '/payments', body: { reference: id, amount: 1000, currency: 'EUR' } },
    ]);

    const before = settlementCount();
    const read = await readSettlement(ben.token, id);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id,
      groupId,
      from: ben.id,
      to: ann.id,
      amount: 1000,
      method: 'provider',
      status: 'pending',
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/),
      payUrl: 'https://pay.example.org/1',
    });
    // Ann, the payee, reads it as the group's member; a read changes nothing stored.
    expect((await readSettlement(ann.token, id)).body).toEqual(read.body);
    expect(settlementCount()).toBe(before);
    expect(calls).toHaveLength(1);
  });

  it('counts nothing until the provider says the payment succeeded, then counts it as a cash settlement does', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const id = (await askToPay(ben.token, groupId, ann.id, 1000)).body as { id: string };
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1500, [ben.id]: -1500 });

    // A signed webhook, its body as sent: spaces and all, which a re-encoding would change.
    const body = `{ "id": "evt_1", "paymentId": "pay_1", "status": "succeeded", "at": "2026-11-17T10:00:00Z" }`;
    expect(await postWebhook(body, signed(body))).toEqual({ status: 204 });

    expect((await readSettlement(ben.token, id.id)).body).toMatchObject({ status: 'paid', method: 'provider' });
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 500, [ben.id]: -500 });
  });

  it('counts a payment waiting at the provider as paid for what is still owed, and not in the balances', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    expect((await askToPay(ben.token, groupId, ann.id, 1000)).status).toBe(201);

    // Ben still owes 500 once the payment waiting at the provider is counted: a larger cash settlement is refused.
    const cash = await settleInCash(ann.token, groupId, ben.id, 600);
    expect(cash.status).toBe(409);
    expect(cash.body).toMatchObject({ error: 'AmountExceedsBalance' });
    const again = await askToPay(ben.token, groupId, ann.id, 600);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'AmountExceedsBalance' });
    // The suggested settlements leave the waiting payment out; the balances do not count it yet.
    expect(await suggestionsAs(ann.token, groupId)).toEqual([{ from: ben.id, to: ann.id, amount: 500 }]);
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1500, [ben.id]: -1500 });
    expect(calls).toHaveLength(1);

    // The rest of what is owed can be asked for, and then nothing more.
    expect((await askToPay(ben.token, groupId, ann.id, 500)).status).toBe(201);
    expect(await suggestionsAs(ann.token, groupId)).toEqual([]);
  });

  it('refuses a payment the provider does not answer with a payment in time, and keeps nothing', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const refusals: [string, ProviderAnswer][] = [
      ['answers 500', { status: 500, body: { message: 'boom' } }],
      ['answers 200 where 201 is due', { status: 200, body: { id: 'pay_x', payUrl: 'https://pay.example.org/x' } }],
      ['answers 201 without a payUrl', { status: 201, body: { id: 'pay_x' } }],
      ['answers 201 with a body that is not JSON', { status: 201, text: 'not json' }],
      [
        'answers after the time limit',
        { status: 201, body: { id: 'pay_x', payUrl: 'https://pay.example.org/x' }, delayMs: 600 },
      ],
    ];
    for (const [name, answer] of refusals) {
      answerWith = () => answer;
      const reply = await askToPay(ben.token, groupId, ann.id, 1500);
      expect({ name, status: reply.status }).toEqual({ name, status: 424 });
      expect(reply.body).toMatchObject({ error: 'ProviderUnavailable' });
      expect(settlementCount()).toBe(0);
    }
    expect(await suggestionsAs(ann.token, groupId)).toEqual([{ from: ben.id, to: ann.id, amount: 1500 }]);
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1500, [ben.id]: -1500 });
  });

  it('refuses a payment when the provider cannot be reached at all, and keeps nothing', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    // A port nothing listens on: the connection is refused.
    const unreachable = await createApplication({
      databasePath: directory.databasePath,
      providerUrl: 'http://127.0.0.1:9',
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 200,
    });
    extra.push(unreachable);
    await unreachable.start(0);
    const reply = await send(unreachable, 'POST', `/groups/${groupId}/settlements/provider`, {
      token: ben.token,
      body: { to: ann.id, amount: 100 },
    });
    expect(reply.status).toBe(424);
    expect(reply.body).toMatchObject({ error: 'ProviderUnavailable' });
    expect(settlementCount()).toBe(0);
  });

  it('refuses paying through the provider when it is not configured, before asking anyone', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const unconfigured = await createApplication({ databasePath: directory.databasePath, providerUrl: '' });
    extra.push(unconfigured);
    await unconfigured.start(0);
    const reply = await send(unconfigured, 'POST', `/groups/${groupId}/settlements/provider`, {
      token: ben.token,
      body: { to: ann.id, amount: 100 },
    });
    expect(reply.status).toBe(424);
    expect(reply.body).toMatchObject({ error: 'ProviderNotConfigured' });
    expect(calls).toEqual([]);
    expect(settlementCount()).toBe(0);
  });

  it('refuses a request the rules refuse before the provider is asked: a payee who is not a member, the payer as payee, a bad amount, and more than is owed', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const outsider = await signedUpAccount(app, { email: 'out@example.org', name: 'Out' });
    const cy = await signedUpAccount(app, { email: 'cy@example.org', name: 'Cy' });
    await join(ann.token, groupId, cy.token);

    const outsidePayee = await askToPay(ben.token, groupId, outsider.id, 100);
    expect(outsidePayee.status).toBe(422);
    expect(outsidePayee.body).toMatchObject({ error: 'PayeeNotInGroup' });
    const selfPaid = await askToPay(ben.token, groupId, ben.id, 100);
    expect(selfPaid.status).toBe(422);
    expect(selfPaid.body).toMatchObject({ error: 'PayerIsPayee' });
    for (const amount of [0, -5, 1.5]) {
      const reply = await askToPay(ben.token, groupId, ann.id, amount);
      expect(reply.status).toBe(422);
      expect(reply.body).toMatchObject({ error: 'AmountIsInvalid' });
    }
    const tooMuch = await askToPay(ben.token, groupId, ann.id, 1501);
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body).toMatchObject({ error: 'AmountExceedsBalance' });
    // Cy owes nothing, and Ann is owed, not owing: neither can pay.
    expect((await askToPay(cy.token, groupId, ann.id, 1)).body).toMatchObject({ error: 'AmountExceedsBalance' });
    expect((await askToPay(ann.token, groupId, ben.id, 1)).body).toMatchObject({ error: 'AmountExceedsBalance' });

    // A caller who is not a member sees no group; a request with no token is unproven.
    const asOutsider = await askToPay(outsider.token, groupId, ann.id, 1);
    expect(asOutsider.status).toBe(404);
    expect(asOutsider.body).toMatchObject({ error: 'GroupNotFound' });
    const noToken = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
      body: { to: ann.id, amount: 1 },
    });
    expect(noToken.status).toBe(401);

    expect(calls).toEqual([]);
    expect(settlementCount()).toBe(0);
  });

  it('refuses a webhook with no signature, or a wrong one, with 401, and changes nothing', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const id = ((await askToPay(ben.token, groupId, ann.id, 1500)).body as { id: string }).id;
    const { body } = webhookAbout('pay_1', 'succeeded');

    expect(await postWebhook(body)).toEqual({ status: 401 });
    expect(await postWebhook(body, signed(body, 'another secret'))).toEqual({ status: 401 });
    expect(await postWebhook(body, signed(body).toUpperCase())).toEqual({ status: 401 });
    // A signature of other bytes: the body changed after it was signed.
    expect(await postWebhook(body.replace('succeeded', 'failed'), signed(body))).toEqual({ status: 401 });

    expect((await readSettlement(ben.token, id)).body).toMatchObject({ status: 'pending' });
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1500, [ben.id]: -1500 });
  });

  it('refuses every webhook when no webhook secret is configured', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const id = ((await askToPay(ben.token, groupId, ann.id, 1500)).body as { id: string }).id;
    const unsecured = await createApplication({
      databasePath: directory.databasePath,
      providerUrl,
      providerWebhookSecret: '',
    });
    extra.push(unsecured);
    await unsecured.start(0);
    const { body } = webhookAbout('pay_1', 'succeeded');
    const response = await fetch(`${unsecured.address}/${unsecured.apiPrefix}/provider/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'provider-signature': signed(body, '') },
      body,
    });
    expect(response.status).toBe(401);
    expect((await readSettlement(ben.token, id)).body).toMatchObject({ status: 'pending' });
  });

  it('acknowledges a signed webhook whatever it says, and changes nothing it does not decide', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const id = ((await askToPay(ben.token, groupId, ann.id, 1500)).body as { id: string }).id;
    const signedBody = (body: string) => ({ body, signature: signed(body) });
    const webhooks = [
      webhookAbout('pay_1', 'pending'),
      webhookAbout('pay_unknown', 'succeeded'),
      webhookAbout('pay_1', 'refunded'),
      signedBody('this is not JSON at all'),
      signedBody('[1, 2, 3]'),
      signedBody(JSON.stringify({ id: 'evt', paymentId: 42, status: 'succeeded' })),
      signedBody(''),
    ];
    for (const { body, signature } of webhooks) {
      expect(await postWebhook(body, signature)).toEqual({ status: 204 });
    }
    expect((await readSettlement(ben.token, id)).body).toMatchObject({ status: 'pending' });
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1500, [ben.id]: -1500 });
  });

  it('marks a payment failed: it never counts, and the amount it held is free again', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const id = ((await askToPay(ben.token, groupId, ann.id, 1500)).body as { id: string }).id;
    const { body, signature } = webhookAbout('pay_1', 'failed');
    expect(await postWebhook(body, signature)).toEqual({ status: 204 });

    const read = await readSettlement(ben.token, id);
    expect(read.body).toMatchObject({ method: 'provider', status: 'failed' });
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1500, [ben.id]: -1500 });
    // What the failed payment held is free: the same amount is owed again, and can be settled in cash.
    expect(await suggestionsAs(ann.token, groupId)).toEqual([{ from: ben.id, to: ann.id, amount: 1500 }]);
    expect((await settleInCash(ann.token, groupId, ben.id, 1500)).status).toBe(201);
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 0, [ben.id]: 0 });
  });

  it('ends a payment once: a webhook that says otherwise after it has ended changes nothing', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const first = ((await askToPay(ben.token, groupId, ann.id, 500)).body as { id: string }).id;
    const second = ((await askToPay(ben.token, groupId, ann.id, 300)).body as { id: string }).id;

    // pay_1 succeeded, then failed: it stays paid. pay_2 failed, then succeeded: it stays failed.
    for (const [paymentId, status] of [
      ['pay_1', 'succeeded'],
      ['pay_1', 'failed'],
      ['pay_2', 'failed'],
      ['pay_2', 'succeeded'],
    ]) {
      const { body, signature } = webhookAbout(paymentId, status);
      expect(await postWebhook(body, signature)).toEqual({ status: 204 });
    }
    expect((await readSettlement(ben.token, first)).body).toMatchObject({ status: 'paid' });
    expect((await readSettlement(ben.token, second)).body).toMatchObject({ status: 'failed' });
    // Only the paid 500 counts: the failed 300 never does.
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1000, [ben.id]: -1000 });
  });

  it('counts a payment once, however many times its webhook arrives, and however many webhooks say it succeeded', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const id = ((await askToPay(ben.token, groupId, ann.id, 1500)).body as { id: string }).id;
    const { body, signature } = webhookAbout('pay_1', 'succeeded');
    for (let i = 0; i < 3; i++) expect(await postWebhook(body, signature)).toEqual({ status: 204 });
    // Another webhook, under another id, says the same of the same payment: acknowledged, and nothing more.
    const other = webhookWithId('evt_another', 'pay_1', 'succeeded');
    expect(await deliver(app, other)).toBe(204);

    expect((await readSettlement(ben.token, id)).body).toMatchObject({ status: 'paid' });
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 0, [ben.id]: 0 });
    expect(await suggestionsAs(ann.token, groupId)).toEqual([]);
  });

  it('moves a payment only forward: a webhook saying a status it has passed, or has gone past, changes nothing', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const paid = ((await askToPay(ben.token, groupId, ann.id, 500)).body as { id: string }).id;
    const failed = ((await askToPay(ben.token, groupId, ann.id, 300)).body as { id: string }).id;
    // Arriving out of order: a pending after the success it precedes, a pending and a success after the failure.
    const overtaking: [string, string][] = [
      ['pay_1', 'succeeded'],
      ['pay_1', 'pending'],
      ['pay_2', 'failed'],
      ['pay_2', 'pending'],
      ['pay_2', 'succeeded'],
    ];
    for (const [paymentId, status] of overtaking) {
      const { body, signature } = webhookAbout(paymentId, status);
      expect(await postWebhook(body, signature)).toEqual({ status: 204 });
    }

    expect((await readSettlement(ben.token, paid)).body).toMatchObject({ status: 'paid' });
    expect((await readSettlement(ben.token, failed)).body).toMatchObject({ status: 'failed' });
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1000, [ben.id]: -1000 });
  });

  it('applies a webhook that arrives after Tally was stopped and started again, as it would have on time', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const id = ((await askToPay(ben.token, groupId, ann.id, 1500)).body as { id: string }).id;
    await app.stop();
    app = await startApplicationOnFile();

    const { body, signature } = webhookAbout('pay_1', 'succeeded');
    expect(await postWebhook(body, signature)).toEqual({ status: 204 });
    expect((await readSettlement(ben.token, id)).body).toMatchObject({ status: 'paid' });
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 0, [ben.id]: 0 });
  });

  it('is sent again by the provider when Tally was stopped, and acknowledged and applied then', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const id = ((await askToPay(ben.token, groupId, ann.id, 1500)).body as { id: string }).id;
    const webhook = webhookAbout('pay_1', 'succeeded');
    await app.stop();
    // Nothing listens while Tally is stopped: the delivery fails, so the provider sends the webhook again.
    await expect(deliver(app, webhook)).rejects.toThrow();

    app = await startApplicationOnFile();
    expect(await deliver(app, webhook)).toBe(204);
    expect((await readSettlement(ben.token, id)).body).toMatchObject({ status: 'paid' });
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 0, [ben.id]: 0 });
  });

  it('counts a webhook once when two servers on the same file receive it at the same moment', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const id = ((await askToPay(ben.token, groupId, ann.id, 1500)).body as { id: string }).id;
    const second = await startApplicationOnFile();
    extra.push(second);
    const webhook = webhookAbout('pay_1', 'succeeded');

    const statuses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => deliver(i % 2 === 0 ? app : second, webhook)),
    );
    expect(statuses).toEqual(Array.from({ length: 10 }, () => 204));
    expect((await readSettlement(ben.token, id)).body).toMatchObject({ status: 'paid' });
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 0, [ben.id]: 0 });
  });

  it('lets exactly one of two outcomes that arrive at the same moment decide a payment, and balances agree with it', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const second = await startApplicationOnFile();
    extra.push(second);
    let paidTotal = 0;
    for (let round = 0; round < 5; round++) {
      const id = ((await askToPay(ben.token, groupId, ann.id, 100)).body as { id: string }).id;
      const { provider_payment_id: paymentId } = db
        .prepare('SELECT provider_payment_id FROM settlements WHERE id = ?')
        .get(id) as { provider_payment_id: string };
      const [succeeded, failed] = await Promise.all([
        deliver(app, webhookWithId(`evt_success_${round}`, paymentId, 'succeeded')),
        deliver(second, webhookWithId(`evt_failure_${round}`, paymentId, 'failed')),
      ]);
      expect([succeeded, failed]).toEqual([204, 204]);

      const { status } = (await readSettlement(ben.token, id)).body as { status: string };
      expect(['paid', 'failed']).toContain(status);
      if (status === 'paid') paidTotal += 100;
      expect(await balancesAs(ann.token, groupId)).toEqual({
        [ann.id]: 1500 - paidTotal,
        [ben.id]: paidTotal - 1500,
      });
    }
  });

  it('keeps the settlements of a file written before payments through the provider, as paid cash settlements', async () => {
    const legacy = testDirectory();
    try {
      // A file as the application wrote it before payments through the provider: the settlements had no provider.
      const old = new DatabaseSync(legacy.databasePath);
      old.exec(`
        CREATE TABLE accounts (id TEXT PRIMARY KEY);
        CREATE TABLE groups (id TEXT PRIMARY KEY);
        INSERT INTO accounts VALUES ('ann'), ('ben');
        INSERT INTO groups VALUES ('g1');
        CREATE TABLE settlements (
          id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups (id),
          payer_id TEXT NOT NULL REFERENCES accounts (id), payee_id TEXT NOT NULL REFERENCES accounts (id),
          amount INTEGER NOT NULL CHECK (amount >= 1),
          method TEXT NOT NULL CHECK (method IN ('cash')),
          status TEXT NOT NULL CHECK (status IN ('paid')),
          created_at TEXT NOT NULL
        );
        INSERT INTO settlements VALUES ('s1', 'g1', 'ben', 'ann', 700, 'cash', 'paid', '2026-11-01T10:00:00.000Z');
      `);
      old.close();

      const upgraded = openDatabase(legacy.databasePath);
      expect(upgraded.prepare('SELECT id, method, status, pay_url FROM settlements').all()).toEqual([
        { id: 's1', method: 'cash', status: 'paid', pay_url: null },
      ]);
      // The rebuilt table takes a payment through the provider, which the old one refused.
      upgraded.exec(
        `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, provider_payment_id, pay_url, created_at)
         VALUES ('s2', 'g1', 'ben', 'ann', 100, 'provider', 'pending', 'pay_9', 'https://pay.example.org/9', '2026-11-02T10:00:00.000Z')`,
      );
      upgraded.close();
    } finally {
      legacy.remove();
    }
  });
});
