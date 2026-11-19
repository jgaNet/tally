import { createHmac } from 'node:crypto';
import { type Application, createApplication } from '../app';
import { openDatabase } from '../database';
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

describe('the administrators decide a contested settlement', () => {
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
      adminEmails: 'Boss@Example.com, ops@example.com',
    });
  });

  afterEach(async () => {
    await app.stop();
    await provider.close();
  });

  const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');

  let counter = 0;
  /** The provider says `paymentId` has `status`, as a signed webhook. */
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

  let scenarios = 0;
  /**
   * Ada owes Grace 500: Grace paid 1000 split between them. Ada pays 300 through the provider, which says it
   * succeeded, so the settlement is paid. Grace then contests it, when `contested` is not false.
   */
  async function paidThroughProvider(contested = true) {
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
      payload: { description: 'Dinner', amount: 1000, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
    });
    expect(expense.statusCode).toBe(201);
    const asked = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
      token: ada.token,
      payload: { to: grace.id, amount: 300 },
    });
    const id = asked.json<{ id: string }>().id;
    expect((await webhook(provider.payments[provider.payments.length - 1].id, 'succeeded')).statusCode).toBe(204);
    if (contested) {
      expect((await send(app, 'POST', `/settlements/${id}/contest`, { token: grace.token })).statusCode).toBe(204);
    }
    return { ada, grace, groupId, id };
  }

  async function admin(email = 'BOSS@example.com') {
    return signedUpAccount(app, { email, name: 'Boss' });
  }

  async function read(token: string, id: string) {
    return send(app, 'GET', `/settlements/${id}`, { token });
  }

  async function decide(token: string, id: string, paid: boolean) {
    return send(app, 'POST', `/admin/settlements/${id}/decision`, { token, payload: { paid } });
  }

  async function contests(token: string) {
    return send(app, 'GET', '/admin/contests', { token });
  }

  async function log(token: string) {
    return send(app, 'GET', '/admin/log', { token });
  }

  async function balanceOf(token: string, groupId: string, memberId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    return response.json<{ memberId: string; balance: number }[]>().find(b => b.memberId === memberId)?.balance;
  }

  describe('the list of contested settlements', () => {
    it('is the settlements contested now, the earliest contested first, each as the settlement reads it', async () => {
      const boss = await admin();
      const first = await paidThroughProvider(false);
      const second = await paidThroughProvider(false);
      // The second is contested first, so it is the earliest contested.
      await send(app, 'POST', `/settlements/${second.id}/contest`, { token: second.grace.token });
      await send(app, 'POST', `/settlements/${first.id}/contest`, { token: first.grace.token });
      const response = await contests(boss.token);
      expect(response.statusCode).toBe(200);
      const listed = response.json<{ id: string }[]>();
      expect(listed.map(settlement => settlement.id)).toEqual([second.id, first.id]);
      expect(listed[0]).toEqual((await read(second.grace.token, second.id)).json());
      expect(listed[1]).toEqual((await read(first.grace.token, first.id)).json());
    });

    it('is empty once every contested settlement is decided', async () => {
      const boss = await admin();
      const { id } = await paidThroughProvider();
      expect((await contests(boss.token)).json()).toHaveLength(1);
      await decide(boss.token, id, true);
      expect((await contests(boss.token)).json()).toEqual([]);
    });

    it('answers an administrator whatever the case of the email its list gives, as ADMIN_EMAILS does', async () => {
      const ops = await admin('Ops@EXAMPLE.com');
      await paidThroughProvider();
      expect((await contests(ops.token)).statusCode).toBe(200);
    });
  });

  describe('what is refused to anyone who is not an administrator', () => {
    it('the list and the log do not exist for them (404), and a decision is refused (403): nothing changes', async () => {
      const { ada, grace, id } = await paidThroughProvider();
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      for (const member of [ada, grace, eve]) {
        const listed = await contests(member.token);
        expect(listed.statusCode).toBe(404);
        expect((await log(member.token)).statusCode).toBe(404);
        const decided = await decide(member.token, id, true);
        expect(decided.statusCode).toBe(403);
        expect(decided.json().type).toBe('NotAdministrator');
      }
      expect((await read(grace.token, id)).json().status).toBe('contested');
      expect((await log((await admin()).token)).json()).toEqual([]);
    });

    it('is answered 401 to a request with no token', async () => {
      const { id } = await paidThroughProvider();
      expect((await send(app, 'GET', '/admin/contests')).statusCode).toBe(401);
      expect((await send(app, 'GET', '/admin/log')).statusCode).toBe(401);
      expect(
        (await send(app, 'POST', `/admin/settlements/${id}/decision`, { payload: { paid: true } })).statusCode,
      ).toBe(401);
    });
  });

  describe('a decision', () => {
    it('that the money arrived: the settlement is paid again, counted as before, with its history and audit', async () => {
      const boss = await admin();
      const { ada, grace, groupId, id } = await paidThroughProvider();
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-500);
      expect((await decide(boss.token, id, true)).statusCode).toBe(204);

      const settlement = (await read(grace.token, id)).json();
      expect(settlement.status).toBe('paid');
      expect(settlement.history.map((entry: { status: string }) => entry.status)).toEqual([
        'pending',
        'paid',
        'contested',
        'paid',
      ]);
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-200);

      const audit = (await send(app, 'GET', `/groups/${groupId}/audit`, { token: ada.token })).json<
        { action: string; by: string; subjectId: string; amount: number }[]
      >();
      expect(audit).toContainEqual(
        expect.objectContaining({ action: 'settlement-paid', by: boss.id, subjectId: id, amount: 300 }),
      );
    });

    it('that the money did not arrive: the settlement is annulled, and what was owed is owed again', async () => {
      const boss = await admin();
      const { ada, grace, groupId, id } = await paidThroughProvider();
      const auditBefore = (await send(app, 'GET', `/groups/${groupId}/audit`, { token: ada.token })).json<
        { action: string }[]
      >();
      expect((await decide(boss.token, id, false)).statusCode).toBe(204);

      const settlement = (await read(grace.token, id)).json();
      expect(settlement.status).toBe('annulled');
      expect(settlement.history.map((entry: { status: string }) => entry.status)).toEqual([
        'pending',
        'paid',
        'contested',
        'annulled',
      ]);
      expect(await balanceOf(ada.token, groupId, ada.id)).toBe(-500);
      expect(await balanceOf(grace.token, groupId, grace.id)).toBe(500);

      // Annulling is no entry of the audit: the balances stopped counting the settlement when it was contested.
      const auditAfter = (await send(app, 'GET', `/groups/${groupId}/audit`, { token: ada.token })).json<
        { action: string }[]
      >();
      expect(auditAfter).toEqual(auditBefore);
    });

    it('is logged, by the administrator, in the administrators log, whichever it is', async () => {
      const boss = await admin();
      const first = await paidThroughProvider();
      const second = await paidThroughProvider();
      await decide(boss.token, first.id, true);
      await decide(boss.token, second.id, false);

      const entries = (await log(boss.token)).json<
        { id: string; at: string; by: string; action: string; subjectId: string }[]
      >();
      expect(entries).toHaveLength(2);
      expect(entries.map(entry => Object.keys(entry).sort())).toEqual([
        ['action', 'at', 'by', 'id', 'subjectId'],
        ['action', 'at', 'by', 'id', 'subjectId'],
      ]);
      expect(entries.map(({ by, action, subjectId }) => ({ by, action, subjectId }))).toEqual([
        { by: boss.id, action: 'decided-paid', subjectId: first.id },
        { by: boss.id, action: 'decided-annulled', subjectId: second.id },
      ]);
      // The oldest first, each with when it was made.
      expect(entries[0].at <= entries[1].at).toBe(true);
    });

    it('is made once: a decided settlement is not decided again, nor one that was never contested', async () => {
      const boss = await admin();
      const { id } = await paidThroughProvider();
      expect((await decide(boss.token, id, true)).statusCode).toBe(204);
      const again = await decide(boss.token, id, false);
      expect(again.statusCode).toBe(409);
      expect(again.json().type).toBe('NotContested');

      const notContested = await paidThroughProvider(false);
      const refused = await decide(boss.token, notContested.id, true);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().type).toBe('NotContested');

      expect((await decide(boss.token, 'no-such-settlement', true)).statusCode).toBe(404);
      // Refusals decide nothing, so they log nothing.
      expect((await log(boss.token)).json()).toHaveLength(1);
    });

    it('is an entry of the log that is never changed nor removed, in the database', async () => {
      const boss = await admin();
      const { id } = await paidThroughProvider();
      await decide(boss.token, id, true);
      const db = await openDatabase(databaseUrl);
      try {
        await expect(db.execute("UPDATE admin_log SET action = 'decided-annulled'")).rejects.toThrow(
          'never changed or removed',
        );
        await expect(db.execute('DELETE FROM admin_log')).rejects.toThrow('never changed or removed');
      } finally {
        await db.close();
      }
      expect((await log(boss.token)).json()).toHaveLength(1);
    });

    it('needs the paid flag to be a boolean', async () => {
      const boss = await admin();
      const { id } = await paidThroughProvider();
      const response = await send(app, 'POST', `/admin/settlements/${id}/decision`, {
        token: boss.token,
        payload: { paid: 'yes' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('a settlement decided is contested no more', () => {
    it('cannot be contested again, once paid again or annulled', async () => {
      const boss = await admin();
      const paid = await paidThroughProvider();
      await decide(boss.token, paid.id, true);
      const again = await send(app, 'POST', `/settlements/${paid.id}/contest`, { token: paid.grace.token });
      expect(again.statusCode).toBe(409);
      expect(again.json().type).toBe('AlreadyContested');

      const annulled = await paidThroughProvider();
      await decide(boss.token, annulled.id, false);
      const annulledAgain = await send(app, 'POST', `/settlements/${annulled.id}/contest`, {
        token: annulled.grace.token,
      });
      expect(annulledAgain.statusCode).toBe(409);
      expect(annulledAgain.json().type).toBe('AlreadyContested');
      expect((await read(annulled.grace.token, annulled.id)).json().status).toBe('annulled');
    });
  });
});
