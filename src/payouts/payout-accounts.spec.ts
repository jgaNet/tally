import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import {
  type FakeProvider,
  joinThroughInvitation,
  type ProviderAccountMode,
  send,
  signedUpAccount,
  startFakeProvider,
  temporaryDatabaseUrl,
} from '../test-support';

describe('payout accounts', () => {
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

  const setAccount = (token: string, accountId: unknown) =>
    send(app, 'PUT', '/accounts/me/payout-account', { token, payload: { accountId } });

  const readAccount = (token: string) => send(app, 'GET', '/accounts/me/payout-account', { token });

  describe('setting it', () => {
    it('sets the account the provider confirms, which the member then reads', async () => {
      const ada = await signedUpAccount(app);
      expect((await setAccount(ada.token, 'acct-ada')).statusCode).toBe(204);
      const read = await readAccount(ada.token);
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({ accountId: 'acct-ada' });
      expect(provider.accountRequests).toEqual(['acct-ada']);
    });

    it('asks the provider about the account it is given, encoded as one path segment', async () => {
      const ada = await signedUpAccount(app);
      expect((await setAccount(ada.token, 'acct/with slash')).statusCode).toBe(204);
      expect(provider.accountRequests).toEqual(['acct/with slash']);
      expect((await readAccount(ada.token)).json()).toEqual({ accountId: 'acct/with slash' });
    });

    it('replaces the account there was', async () => {
      const ada = await signedUpAccount(app);
      await setAccount(ada.token, 'acct-old');
      expect((await setAccount(ada.token, 'acct-new')).statusCode).toBe(204);
      expect((await readAccount(ada.token)).json()).toEqual({ accountId: 'acct-new' });
    });

    it('refuses an account the provider does not know with 422, and keeps the one there was', async () => {
      const ada = await signedUpAccount(app);
      await setAccount(ada.token, 'acct-known');
      provider.unknownAccounts.push('acct-unknown');
      const response = await setAccount(ada.token, 'acct-unknown');
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ type: 'UnknownPayoutAccount', message: expect.any(String) });
      expect((await readAccount(ada.token)).json()).toEqual({ accountId: 'acct-known' });
    });

    it('refuses an account the provider does not confirm with 409, and keeps the one there was', async () => {
      const ada = await signedUpAccount(app);
      await setAccount(ada.token, 'acct-known');
      const modes: ProviderAccountMode[] = ['refuse', 'malformed', 'hang', 'other'];
      for (const mode of modes) {
        provider.accountMode = mode;
        const response = await setAccount(ada.token, 'acct-known-2');
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({ type: 'PayoutAccountNotConfirmed', message: expect.any(String) });
      }
      provider.accountMode = 'accept';
      expect((await readAccount(ada.token)).json()).toEqual({ accountId: 'acct-known' });
    });

    it('refuses with 409 when no provider is set up on this server, and keeps nothing', async () => {
      await app.stop();
      app = await createApplication({ databaseUrl: await temporaryDatabaseUrl() });
      const ada = await signedUpAccount(app);
      const response = await setAccount(ada.token, 'acct-ada');
      expect(response.statusCode).toBe(409);
      expect(response.json().type).toBe('ProviderNotConfigured');
      expect((await readAccount(ada.token)).statusCode).toBe(404);
    });

    it('answers 401 to a request with no token, and asks the provider nothing', async () => {
      const response = await send(app, 'PUT', '/accounts/me/payout-account', { payload: { accountId: 'acct-ada' } });
      expect(response.statusCode).toBe(401);
      expect((await send(app, 'GET', '/accounts/me/payout-account')).statusCode).toBe(401);
      expect(provider.accountRequests).toEqual([]);
    });

    it('refuses a body with no account, or a blank one, with 400, and asks the provider nothing', async () => {
      const ada = await signedUpAccount(app);
      expect(
        (await send(app, 'PUT', '/accounts/me/payout-account', { token: ada.token, payload: {} })).statusCode,
      ).toBe(400);
      expect((await setAccount(ada.token, '')).statusCode).toBe(400);
      expect((await setAccount(ada.token, 12)).statusCode).toBe(400);
      expect(provider.accountRequests).toEqual([]);
    });
  });

  describe('reading it', () => {
    it('answers 404 to a member who has no payout account', async () => {
      const ada = await signedUpAccount(app);
      const response = await readAccount(ada.token);
      expect(response.statusCode).toBe(404);
      expect(response.json().type).toBe('NotFound');
    });

    it('answers each member only their own: another member reads their own, or 404', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      await setAccount(ada.token, 'acct-ada');
      expect((await readAccount(grace.token)).statusCode).toBe(404);
      expect((await readAccount(ada.token)).json()).toEqual({ accountId: 'acct-ada' });
    });
  });

  describe('a cash settlement', () => {
    it('needs no payout account, and is recorded for a payee who has none', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const created = await send(app, 'POST', '/groups', {
        token: ada.token,
        payload: { name: 'Flat', currency: 'EUR' },
      });
      const groupId = created.json<{ id: string }>().id;
      await joinThroughInvitation(app, ada.token, grace.token, groupId);
      const expense = await send(app, 'POST', `/groups/${groupId}/expenses`, {
        token: grace.token,
        payload: { description: 'Dinner', amount: 1000, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
      });
      expect(expense.statusCode).toBe(201);
      const cash = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: grace.token,
        payload: { from: ada.id, amount: 500 },
      });
      expect(cash.statusCode).toBe(201);
      expect(provider.requests).toEqual([]);
    });
  });
});
