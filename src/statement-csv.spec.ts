import { createHmac } from 'node:crypto';
import { Application } from './app';
import { todayUtc } from './days';
import { ada, call, FakeProvider, startApplication, startFakeProvider, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };

const PAST_DAY = '2026-11-01';
const adaPayout = 'acct_ada';
const SECRET = 'whsec_test';
const AT = '2026-11-20T10:00:00Z';

describe("a member's statement with the settlements the balances count, and as CSV", () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let provider: FakeProvider;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;
  let outsiderToken: string;
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

  async function record(token: string, fields: Record<string, unknown>): Promise<string> {
    const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: { description: 'Expense', date: PAST_DAY, ...fields },
      token,
    });
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  const settle = (body: unknown, token: string) =>
    call(app, 'POST', `/groups/${groupId}/settlements/cash`, { body, token });

  const askProvider = (body: unknown, token: string) =>
    call(app, 'POST', `/groups/${groupId}/settlements/provider`, { body, token });

  const refund = (settlementId: string, token: string) =>
    call(app, 'POST', `/settlements/${settlementId}/refund`, { token });

  /** The webhook body, as the provider sends it, and its signature. */
  function signed(event: Record<string, unknown>): { raw: string; signature: string } {
    const raw = JSON.stringify(event);
    return { raw, signature: createHmac('sha256', SECRET).update(raw).digest('hex') };
  }

  const decide = (paymentId: string, status: string) => {
    const { raw, signature } = signed({ id: `wh_${paymentId}_${status}`, paymentId, status, at: AT });
    return call(app, 'POST', '/provider/webhooks', { raw, headers: { 'Provider-Signature': signature } });
  };

  const statement = (memberId: string, token = adaToken) =>
    call(app, 'GET', `/groups/${groupId}/members/${memberId}/statement`, { token });

  /** The statement as CSV: the answer's status, its content type and its text, read as UTF-8. */
  async function statementCsv(memberId: string, token = adaToken) {
    const response = await fetch(
      `${app.address}/${app.apiPrefix}/groups/${groupId}/members/${memberId}/statement.csv`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      text: await response.text(),
    };
  }

  const groupBalance = async (memberId: string): Promise<number> =>
    (await call(app, 'GET', `/groups/${groupId}/balances`, { token: adaToken })).body.find(
      (row: { memberId: string }) => row.memberId === memberId,
    ).balance;

  beforeEach(async () => {
    database = temporaryDatabase();
    provider = await startFakeProvider();
    app = await startApplication(database.url, { providerUrl: provider.url, providerWebhookSecret: SECRET });
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    expect(
      (await call(app, 'PUT', '/accounts/me/payout-account', { body: { accountId: adaPayout }, token: adaToken }))
        .status,
    ).toBe(204);
    provider.requests.splice(0);
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
    ({ token: outsiderToken } = await accountOf(outsiderAccount));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    await join(graceToken);
    await join(linusToken);
  });

  afterEach(async () => {
    await app.stop();
    await provider.stop();
    await database.remove();
  });

  describe('the settlements in a statement', () => {
    it('lists a cash settlement beside the expenses: the payer pays, the payee receives it', async () => {
      const expense = await record(adaToken, { amount: 1000, splitBetween: [adaId, graceId] });
      const settled = (await settle({ from: graceId, amount: 300 }, adaToken)).body.id;
      const today = todayUtc();

      expect((await statement(graceId, graceToken)).body).toEqual({
        memberId: graceId,
        balance: -200,
        entries: [
          {
            kind: 'expense',
            expenseId: expense,
            date: PAST_DAY,
            description: 'Expense',
            paid: 0,
            share: 500,
            balance: -500,
          },
          {
            kind: 'settlement',
            settlementId: settled,
            date: today,
            description: 'Settlement in cash',
            paid: 300,
            share: 0,
            balance: -200,
          },
        ],
      });
      expect((await statement(adaId)).body.entries).toEqual([
        expect.objectContaining({ kind: 'expense', expenseId: expense, paid: 1000, share: 500, balance: 500 }),
        {
          kind: 'settlement',
          settlementId: settled,
          date: today,
          description: 'Settlement in cash',
          paid: 0,
          share: 300,
          balance: 200,
        },
      ]);
    });

    it('orders a settlement among the expenses of its day by when the balances started to count it', async () => {
      const today = todayUtc();
      const first = await record(adaToken, { amount: 1000, date: today, splitBetween: [adaId, graceId] });
      const settled = (await settle({ from: graceId, amount: 100 }, adaToken)).body.id;
      const second = await record(adaToken, { amount: 600, date: today, splitBetween: [adaId, graceId] });

      const ids = (await statement(graceId)).body.entries.map(
        (entry: { expenseId?: string; settlementId?: string }) => entry.expenseId ?? entry.settlementId,
      );
      expect(ids).toEqual([first, settled, second]);
    });

    it('lists a settlement through the provider once it is paid, dated by the day the balances started to count it', async () => {
      // Grace owes Ada 1000 for a dinner: she may pay it through the provider.
      const dinner = await record(adaToken, { amount: 2000, splitBetween: [adaId, graceId] });
      const asked = await askProvider({ to: adaId, amount: 1000 }, graceToken);
      expect(asked.status).toBe(201);
      const settlement = asked.body.id;
      // Waiting at the provider, it is not counted, so it is not in the statement.
      expect((await statement(graceId, graceToken)).body.entries.map((entry: { kind: string }) => entry.kind)).toEqual([
        'expense',
      ]);

      expect((await decide('pay_1', 'succeeded')).status).toBe(204);
      const settled = (await call(app, 'GET', `/groups/${groupId}/settlements`, { token: adaToken })).body[0];
      const paidAt: string = settled.history.find((entry: { status: string }) => entry.status === 'paid').at;
      // Grace is the payer: what she paid counts for her, and Ada's share is the same amount.
      expect((await statement(graceId, graceToken)).body).toEqual({
        memberId: graceId,
        balance: 0,
        entries: [
          expect.objectContaining({ kind: 'expense', expenseId: dinner, paid: 0, share: 1000, balance: -1000 }),
          {
            kind: 'settlement',
            settlementId: settlement,
            date: paidAt.slice(0, 10),
            description: 'Settlement through the provider',
            paid: 1000,
            share: 0,
            balance: 0,
          },
        ],
      });
      expect((await statement(adaId)).body.entries).toEqual([
        expect.objectContaining({ kind: 'expense', expenseId: dinner, paid: 2000, share: 1000, balance: 1000 }),
        expect.objectContaining({ kind: 'settlement', settlementId: settlement, paid: 0, share: 1000, balance: 0 }),
      ]);
    });

    it('keeps a settlement being refunded in the statement, and leaves out one that is refunded', async () => {
      await record(adaToken, { amount: 2000, splitBetween: [adaId, graceId] });
      const settlement = (await askProvider({ to: adaId, amount: 1000 }, graceToken)).body.id;
      expect((await decide('pay_1', 'succeeded')).status).toBe(204);
      expect((await refund(settlement, adaToken)).status).toBe(204);
      const settlementIds = async () =>
        (await statement(graceId, graceToken)).body.entries
          .filter((entry: { kind: string }) => entry.kind === 'settlement')
          .map((entry: { settlementId: string }) => entry.settlementId);
      expect(await settlementIds()).toEqual([settlement]);

      expect((await decide('pay_1', 'refunded')).status).toBe(204);
      expect(await settlementIds()).toEqual([]);
      const after = (await statement(graceId, graceToken)).body;
      expect(after.balance).toBe(-1000);
      expect(after.balance).toBe(await groupBalance(graceId));
    });

    it('answers a statement whose balance is the balance of the group, for every member', async () => {
      await record(adaToken, { amount: 900, splitBetween: [adaId, graceId, linusId] });
      await settle({ from: graceId, amount: 100 }, adaToken);
      await settle({ from: linusId, amount: 50 }, adaToken);
      for (const memberId of [adaId, graceId, linusId]) {
        const answer = (await statement(memberId)).body;
        expect(answer.balance).toBe(await groupBalance(memberId));
      }
    });
  });

  describe('the statement as CSV', () => {
    it('answers the statement as CSV: a header, then a CRLF-ended line for each entry, in the statement order', async () => {
      await record(adaToken, { amount: 1000, splitBetween: [adaId, graceId] });
      await settle({ from: graceId, amount: 300 }, adaToken);
      const answer = await statementCsv(graceId, graceToken);
      const json = (await statement(graceId, graceToken)).body;

      expect(answer.status).toBe(200);
      expect(answer.contentType).toMatch(/^text\/csv/);
      const expected = [
        'date,kind,id,description,paid,share,balance',
        ...json.entries.map(
          (entry: {
            date: string;
            kind: string;
            expenseId?: string;
            settlementId?: string;
            description: string;
            paid: number;
            share: number;
            balance: number;
          }) =>
            [
              entry.date,
              entry.kind,
              entry.expenseId ?? entry.settlementId,
              entry.description,
              entry.paid,
              entry.share,
              entry.balance,
            ].join(','),
        ),
      ];
      expect(answer.text).toBe(expected.map(line => `${line}\r\n`).join(''));
    });

    it('answers only the header line for a member with no entry', async () => {
      expect(await statementCsv(linusId)).toEqual({
        status: 200,
        contentType: expect.stringMatching(/^text\/csv/),
        text: 'date,kind,id,description,paid,share,balance\r\n',
      });
    });

    it('quotes a field holding a comma, a double quote or a line break, doubling the quotes, and no other', async () => {
      const tricky = await record(adaToken, {
        description: 'Dinner, "the good one"\nlate',
        amount: 1000,
        splitBetween: [adaId, graceId],
      });
      const plain = await record(adaToken, { description: 'Coffee', amount: 200, splitBetween: [adaId] });
      const text = (await statementCsv(adaId)).text;
      const lines = text.split('\r\n');
      // The line break in the description is inside its quotes: the CSV has a header, two entries, and the end.
      expect(text.endsWith('\r\n')).toBe(true);
      expect(text).toContain(`${PAST_DAY},expense,${tricky},"Dinner, ""the good one""\nlate",1000,500,500\r\n`);
      expect(text).toContain(`${PAST_DAY},expense,${plain},Coffee,200,200,500\r\n`);
      expect(lines[0]).toBe('date,kind,id,description,paid,share,balance');
    });

    it('answers the text in UTF-8', async () => {
      await record(adaToken, { description: 'Café', amount: 300, splitBetween: [adaId] });
      expect((await statementCsv(adaId)).text).toContain(`${PAST_DAY},expense,`);
      expect((await statementCsv(adaId)).text).toContain(',Café,300,300,0\r\n');
    });

    it('answers a former member’s statement to the members of the group, and 404 to others', async () => {
      await record(adaToken, { amount: 400, splitBetween: [adaId, linusId] });
      // Linus owes 200: a settlement to Ada brings the balance to 0, so Linus may leave.
      await settle({ from: linusId, amount: 200 }, adaToken);
      expect((await call(app, 'POST', `/groups/${groupId}/leave`, { token: linusToken })).status).toBe(204);
      expect((await statementCsv(linusId, graceToken)).status).toBe(200);
      expect((await statementCsv(linusId, outsiderToken)).status).toBe(404);
      expect((await statementCsv('no-such-member', graceToken)).status).toBe(404);
    });

    it('refuses an account that is not signed in, and changes nothing', async () => {
      const response = await fetch(`${app.address}/${app.apiPrefix}/groups/${groupId}/members/${adaId}/statement.csv`);
      expect(response.status).toBe(401);
    });
  });
});
