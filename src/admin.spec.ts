import { createHmac } from 'node:crypto';
import { Application } from './app';
import { parseAdminEmails } from './admin';
import { ada, call, FakeProvider, startApplication, startFakeProvider, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
// The administrator is started with its email in capitals and with spaces: an account is one whatever the case of its email.
const administrator = { email: 'Admin@Example.com', password: 'administer-2026', name: 'Administrator' };
const notAdministrator = { email: 'notadmin@example.com', password: 'not-an-admin', name: 'Not An Admin' };

const PAST_DAY = '2026-11-01';
const adaPayout = 'acct_ada';
const SECRET = 'whsec_test';
const AT = '2026-11-20T10:00:00Z';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;

describe('parsing the administrators’ emails', () => {
  it('reads ADMIN_EMAILS as emails separated by commas, in lowercase, blank entries ignored', () => {
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(parseAdminEmails('')).toEqual([]);
    expect(parseAdminEmails(' Ada@Example.com , ,grace@example.com,')).toEqual([
      'ada@example.com',
      'grace@example.com',
    ]);
  });
});

describe('the administrators: the contests they decide and the log they keep', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let provider: FakeProvider;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;
  let adminId: string;
  let adminToken: string;
  let notAdminToken: string;
  let groupId: string;

  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  async function join(accountToken: string): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    const answer = await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken });
    expect(answer.status).toBe(204);
  }

  const askProvider = (body: unknown, token: string) =>
    call(app, 'POST', `/groups/${groupId}/settlements/provider`, { body, token });

  /** Asks the provider for a payment of the settlement, and the provider says it succeeded: the payment is the one it is numbered. */
  async function paidSettlement(token: string, to: string): Promise<string> {
    const answer = await askProvider({ to, amount: 1000 }, token);
    expect(answer.status).toBe(201);
    const paymentId = `pay_${provider.requests.length}`;
    expect((await decide(paymentId, 'succeeded')).status).toBe(204);
    return answer.body.id;
  }

  const contest = (settlementId: string, token: string) =>
    call(app, 'POST', `/settlements/${settlementId}/contest`, { token });

  const decision = (settlementId: string, paid: unknown, token = adminToken) =>
    call(app, 'POST', `/admin/settlements/${settlementId}/decision`, { body: { paid }, token });

  const contests = (token = adminToken) => call(app, 'GET', '/admin/contests', { token });
  const log = (token = adminToken) => call(app, 'GET', '/admin/log', { token });

  function signed(event: Record<string, unknown>): { raw: string; signature: string } {
    const raw = JSON.stringify(event);
    return { raw, signature: createHmac('sha256', SECRET).update(raw).digest('hex') };
  }

  const decide = (paymentId: string, status: string, id = `wh_${paymentId}_${status}`) => {
    const { raw, signature } = signed({ id, paymentId, status, at: AT });
    return call(app, 'POST', '/provider/webhooks', { raw, headers: { 'Provider-Signature': signature } });
  };

  beforeEach(async () => {
    database = temporaryDatabase();
    provider = await startFakeProvider();
    app = await startApplication(database.url, {
      providerUrl: provider.url,
      providerWebhookSecret: SECRET,
      adminEmails: [' ADMIN@example.com ', ''],
    });
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    expect(
      (await call(app, 'PUT', '/accounts/me/payout-account', { body: { accountId: adaPayout }, token: adaToken }))
        .status,
    ).toBe(204);
    provider.requests.splice(0);
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
    ({ id: adminId, token: adminToken } = await accountOf(administrator));
    ({ token: notAdminToken } = await accountOf(notAdministrator));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    await join(graceToken);
    await join(linusToken);
    // Ada paid 3000, split equally: Ada is owed 2000, Grace and Linus each owe 1000.
    const expense = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: {
        description: 'Dinner',
        amount: 3000,
        date: PAST_DAY,
        splitExactly: [
          { memberId: adaId, amount: 1000 },
          { memberId: graceId, amount: 1000 },
          { memberId: linusId, amount: 1000 },
        ],
      },
      token: adaToken,
    });
    expect(expense.status).toBe(201);
  });

  afterEach(async () => {
    await app.stop();
    await provider.stop();
    await database.remove();
  });

  describe('who is an administrator', () => {
    it('is an account whose email is one ADMIN_EMAILS lists, whatever its case: it reads and decides', async () => {
      expect((await contests()).status).toBe(200);
      expect((await log()).status).toBe(200);
    });

    it('is refused the contests and the log to anyone else, for whom they do not exist', async () => {
      const contestsAnswer = await contests(notAdminToken);
      expect(contestsAnswer.status).toBe(404);
      expect(contestsAnswer.body.type).toBe('NotFound');
      const logAnswer = await log(notAdminToken);
      expect(logAnswer.status).toBe(404);
      expect(logAnswer.body.type).toBe('NotFound');
    });

    it('is refused the decision to anyone else, and nothing changes', async () => {
      const settlement = await paidSettlement(graceToken, adaId);
      expect((await contest(settlement, adaToken)).status).toBe(204);
      const refused = await decision(settlement, true, notAdminToken);
      expect(refused.status).toBe(403);
      expect(refused.body.type).toBe('NotAllowed');
      expect((await call(app, 'GET', `/settlements/${settlement}`, { token: adaToken })).body.status).toBe('contested');
      expect((await log()).body).toEqual([]);
    });

    it('answers no one who is not signed in', async () => {
      expect((await call(app, 'GET', '/admin/log')).status).toBe(401);
      expect((await call(app, 'GET', '/admin/contests')).status).toBe(401);
    });

    it('is not made one through the API: signing up with an administrator’s email is what makes the account one', async () => {
      // The account of an email the server does not list is not an administrator, whoever asks for it.
      const outsider = await accountOf({ email: 'other@example.com', password: 'another-pass', name: 'Other' });
      expect((await call(app, 'GET', '/admin/log', { token: outsider.token })).status).toBe(404);
    });
  });

  describe('the contests the administrators list', () => {
    it('lists the settlements contested now, the earliest contested first, each as the settlement is read', async () => {
      // Grace's payment is made first, and Linus's second; Linus’s contest comes first.
      const graceSettlement = await paidSettlement(graceToken, adaId);
      const linusSettlement = await paidSettlement(linusToken, adaId);
      expect((await contest(linusSettlement, adaToken)).status).toBe(204);
      expect((await contest(graceSettlement, adaToken)).status).toBe(204);

      const listed = await contests();
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([
        (await call(app, 'GET', `/settlements/${linusSettlement}`, { token: adaToken })).body,
        (await call(app, 'GET', `/settlements/${graceSettlement}`, { token: adaToken })).body,
      ]);
      expect(listed.body[0]).toMatchObject({ status: 'contested', method: 'provider', amount: 1000 });
    });

    it('lists the settlements the administrators read whatever their group, though they are not members of it', async () => {
      const settlement = await paidSettlement(graceToken, adaId);
      expect((await contest(settlement, adaToken)).status).toBe(204);
      expect((await contests()).body.map((row: { id: string }) => row.id)).toEqual([settlement]);
      // The administrator is no member, so the settlement does not exist for them as a member reads it.
      expect((await call(app, 'GET', `/settlements/${settlement}`, { token: adminToken })).status).toBe(404);
    });

    it('no longer lists a settlement once it is decided', async () => {
      const settlement = await paidSettlement(graceToken, adaId);
      expect((await contest(settlement, adaToken)).status).toBe(204);
      expect((await decision(settlement, false)).status).toBe(204);
      expect((await contests()).body).toEqual([]);
    });
  });

  describe('the decision', () => {
    it('is refused for a settlement not contested, and for an unknown one, and nothing changes', async () => {
      const settlement = await paidSettlement(graceToken, adaId);
      const notContested = await decision(settlement, true);
      expect(notContested.status).toBe(409);
      expect(notContested.body.type).toBe('NotContested');
      expect((await decision('00000000-0000-0000-0000-000000000000', true)).status).toBe(404);
      expect((await call(app, 'GET', `/settlements/${settlement}`, { token: adaToken })).body.status).toBe('paid');
    });

    it('needs the decision as a boolean', async () => {
      const settlement = await paidSettlement(graceToken, adaId);
      expect((await contest(settlement, adaToken)).status).toBe(204);
      const answer = await decision(settlement, 'yes');
      expect(answer.status).toBe(400);
      expect((await call(app, 'GET', `/settlements/${settlement}`, { token: adaToken })).body.status).toBe('contested');
    });
  });

  describe('the administrators’ log', () => {
    it('is empty until an administrator decides, and then keeps every decision, the oldest first', async () => {
      expect((await log()).body).toEqual([]);
      const first = await paidSettlement(graceToken, adaId);
      const second = await paidSettlement(linusToken, adaId);
      expect((await contest(first, adaToken)).status).toBe(204);
      expect((await contest(second, adaToken)).status).toBe(204);
      expect((await decision(first, true)).status).toBe(204);
      expect((await decision(second, false)).status).toBe(204);

      const entries = (await log()).body;
      expect(entries).toEqual([
        {
          id: expect.any(String),
          at: expect.stringMatching(ISO),
          by: adminId,
          action: 'decided-paid',
          subjectId: first,
        },
        {
          id: expect.any(String),
          at: expect.stringMatching(ISO),
          by: adminId,
          action: 'decided-annulled',
          subjectId: second,
        },
      ]);
    });

    it('changes nothing when it is read, and no request removes an entry', async () => {
      const settlement = await paidSettlement(graceToken, adaId);
      expect((await contest(settlement, adaToken)).status).toBe(204);
      expect((await decision(settlement, true)).status).toBe(204);
      const before = (await log()).body;
      expect((await log()).body).toEqual(before);
      // A refused decision, and one that is not made, are not in the log.
      expect((await decision(settlement, true)).status).toBe(409);
      expect((await decision(settlement, false, notAdminToken)).status).toBe(403);
      expect((await log()).body).toEqual(before);
    });
  });
});
