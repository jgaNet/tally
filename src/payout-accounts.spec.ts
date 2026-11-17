import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Application, createApplication } from './app';
import { send, signedUpAccount, testDirectory, type TestDirectory } from './test-helpers';

/** The answer a fake provider gives to one request about an account. */
interface ProviderAnswer {
  status: number;
  body?: unknown;
  /** Sent as the body instead of `body`, as it is. */
  text?: string;
  /** Waits this long before answering. */
  delayMs?: number;
}

/** A request the fake provider received. */
interface ProviderCall {
  method: string | undefined;
  path: string | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('payout accounts', () => {
  let directory: TestDirectory;
  let app: Application;
  let provider: Server;
  let providerUrl: string;
  let calls: ProviderCall[];
  /** The accounts the fake provider knows. */
  let known: Set<string>;
  /** The answer to a request about the account `path`; by default `200 { id }` for a known account, `404` otherwise. */
  let answerWith: (path: string) => ProviderAnswer;
  /** Applications started by a test beyond `app`, stopped after it. */
  const extra: Application[] = [];

  beforeEach(async () => {
    directory = testDirectory();
    calls = [];
    known = new Set(['acct_ann', 'acct_ann_2', 'acct_ben']);
    answerWith = path => {
      const id = decodeURIComponent(path.slice('/accounts/'.length));
      return known.has(id) ? { status: 200, body: { id } } : { status: 404 };
    };
    provider = createServer((request, response) => {
      calls.push({ method: request.method, path: request.url });
      const answer = answerWith(request.url ?? '');
      void (async () => {
        if (answer.delayMs) await sleep(answer.delayMs);
        try {
          response.writeHead(answer.status, { 'content-type': 'application/json' });
          response.end(answer.text ?? (answer.body === undefined ? '' : JSON.stringify(answer.body)));
        } catch {
          // The caller gave up on the answer already.
        }
      })();
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    app = await createApplication({ databasePath: directory.databasePath, providerUrl, providerTimeoutMs: 200 });
    await app.start(0);
  });

  afterEach(async () => {
    for (const other of extra.splice(0)) await other.stop();
    await app.stop();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    provider.closeAllConnections();
    directory.remove();
  });

  /** Sets `accountId` as the payout account of `token`'s account, as the request answers it. */
  function setAs(token: string | undefined, accountId: unknown, on: Application = app) {
    return send(on, 'PUT', '/accounts/me/payout-account', {
      token,
      body: { accountId },
    });
  }

  /** The payout account of `token`'s account, as it reads it. */
  function readAs(token: string, on: Application = app) {
    return send(on, 'GET', '/accounts/me/payout-account', { token });
  }

  it('sets the payout account the provider knows, asking it once, and reads it back as the caller’s own', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const set = await setAs(ann.token, 'acct_ann');
    expect(set.status).toBe(204);
    expect(calls).toEqual([{ method: 'GET', path: '/accounts/acct_ann' }]);

    const read = await readAs(ann.token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ accountId: 'acct_ann' });
  });

  it('answers 404 when the caller has no payout account', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const read = await readAs(ann.token);
    expect(read.status).toBe(404);
    expect(read.body).toMatchObject({ error: 'PayoutAccountNotFound' });
  });

  it('replaces the payout account the caller had', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    expect((await setAs(ann.token, 'acct_ann')).status).toBe(204);
    expect((await setAs(ann.token, 'acct_ann_2')).status).toBe(204);
    expect(await readAs(ann.token)).toMatchObject({ status: 200, body: { accountId: 'acct_ann_2' } });
  });

  it('lets nobody else read a member’s payout account: another member sees only their own, or none', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    expect((await setAs(ann.token, 'acct_ann')).status).toBe(204);

    const asBen = await readAs(ben.token);
    expect(asBen.status).toBe(404);
    expect(asBen.body).toMatchObject({ error: 'PayoutAccountNotFound' });
    expect((await setAs(ben.token, 'acct_ben')).status).toBe(204);
    expect(await readAs(ben.token)).toMatchObject({ body: { accountId: 'acct_ben' } });
    expect(await readAs(ann.token)).toMatchObject({ body: { accountId: 'acct_ann' } });
  });

  it('refuses an account the provider does not know, with 422, and keeps the one the caller had', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    expect((await setAs(ann.token, 'acct_ann')).status).toBe(204);

    const refused = await setAs(ann.token, 'acct_unknown');
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ error: 'PayoutAccountIsUnknown' });
    expect(calls).toContainEqual({ method: 'GET', path: '/accounts/acct_unknown' });
    expect(await readAs(ann.token)).toMatchObject({ body: { accountId: 'acct_ann' } });
  });

  it('refuses an account when the provider answers anything but its id with 200, or does not answer in time, and keeps nothing', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const refusals: [string, ProviderAnswer][] = [
      ['answers 500', { status: 500, body: { message: 'boom' } }],
      ['answers 201 where 200 is due', { status: 201, body: { id: 'acct_ann' } }],
      ['answers 200 with another id', { status: 200, body: { id: 'acct_other' } }],
      ['answers 200 without an id', { status: 200, body: {} }],
      ['answers 200 with a body that is not JSON', { status: 200, text: 'not json' }],
      ['answers 200 after the time limit', { status: 200, body: { id: 'acct_ann' }, delayMs: 600 }],
    ];
    for (const [name, answer] of refusals) {
      answerWith = () => answer;
      const reply = await setAs(ann.token, 'acct_ann');
      expect({ name, status: reply.status }).toEqual({ name, status: 424 });
      expect(reply.body).toMatchObject({ error: 'ProviderUnavailable' });
    }
    // Nothing was kept: the caller still has none.
    expect((await readAs(ann.token)).status).toBe(404);
  });

  it('refuses an account when the provider cannot be reached at all, and keeps nothing', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    // A port nothing listens on: the connection is refused.
    const unreachable = await createApplication({
      databasePath: directory.databasePath,
      providerUrl: 'http://127.0.0.1:9',
      providerTimeoutMs: 200,
    });
    extra.push(unreachable);
    await unreachable.start(0);
    const reply = await setAs(ann.token, 'acct_ann', unreachable);
    expect(reply.status).toBe(424);
    expect(reply.body).toMatchObject({ error: 'ProviderUnavailable' });
    expect((await readAs(ann.token)).status).toBe(404);
  });

  it('refuses setting a payout account when the provider is not configured, before anyone is asked', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const unconfigured = await createApplication({ databasePath: directory.databasePath, providerUrl: '' });
    extra.push(unconfigured);
    await unconfigured.start(0);
    const reply = await setAs(ann.token, 'acct_ann', unconfigured);
    expect(reply.status).toBe(424);
    expect(reply.body).toMatchObject({ error: 'ProviderNotConfigured' });
    expect(calls).toEqual([]);
  });

  it('refuses an empty account id with 422, before the provider is asked', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const reply = await setAs(ann.token, '');
    expect(reply.status).toBe(422);
    expect(reply.body).toMatchObject({ error: 'AccountIdIsInvalid' });
    expect(calls).toEqual([]);
  });

  it('refuses a request with no token with 401, and a body that is not an account id with 400', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    expect((await setAs(undefined, 'acct_ann')).status).toBe(401);
    expect((await send(app, 'GET', '/accounts/me/payout-account')).status).toBe(401);
    expect((await send(app, 'PUT', '/accounts/me/payout-account', { token: ann.token, body: {} })).status).toBe(400);
    expect((await setAs(ann.token, 5)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('answers a read without asking the provider, and changes nothing', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    expect((await setAs(ann.token, 'acct_ann')).status).toBe(204);
    expect(calls).toHaveLength(1);
    await readAs(ann.token);
    await readAs(ann.token);
    expect(calls).toHaveLength(1);
    expect(await readAs(ann.token)).toMatchObject({ body: { accountId: 'acct_ann' } });
  });

  it('keeps the payout account across a restart on the same file', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    expect((await setAs(ann.token, 'acct_ann')).status).toBe(204);
    await app.stop();

    app = await createApplication({ databasePath: directory.databasePath, providerUrl, providerTimeoutMs: 200 });
    await app.start(0);
    expect(await readAs(ann.token)).toMatchObject({ status: 200, body: { accountId: 'acct_ann' } });
  });
});
