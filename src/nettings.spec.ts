import { Application } from './app';
import { countRows, readRows } from './test-support';
import { ada, call, FakeProvider, startApplication, startFakeProvider, temporaryDatabase } from './test-support';

const bobAccount = { email: 'bob@example.com', password: 'climbing-club', name: 'Bob' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };

const PAST_DAY = '2026-11-01';
const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;
// The provider's id of Bob's payout account.
const bobPayout = 'acct_bob';

describe('netting what two people owe each other across their groups', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let provider: FakeProvider;
  const extraApps: Application[] = [];
  let annId: string;
  let annToken: string;
  let bobId: string;
  let bobToken: string;
  let outsiderId: string;
  let outsiderToken: string;

  /** Signs the account up and in, and answers its id and token. */
  async function accountOf(account: typeof ada, using: Application = app): Promise<{ id: string; token: string }> {
    const id = (await call(using, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(using, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  /** Makes a group in the currency, owned by Ann, with Bob in it. Created in the order the calls are made. */
  async function makeGroup(name: string, currency: string): Promise<string> {
    const id = (await call(app, 'POST', '/groups', { body: { name, currency }, token: annToken })).body.id;
    const invitation = await call(app, 'POST', `/groups/${id}/invitations`, { token: annToken });
    const answer = await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: bobToken });
    expect(answer.status).toBe(204);
    return id;
  }

  /** Records an expense of the group, paid by the account with `payerToken` and split equally between Ann and Bob. */
  async function expense(groupId: string, payerToken: string, amount: number): Promise<void> {
    const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: { description: 'Expense', amount, date: PAST_DAY, splitBetween: [annId, bobId] },
      token: payerToken,
    });
    expect(answer.status).toBe(201);
  }

  const net = (body: unknown, token: string, using: Application = app) =>
    call(using, 'POST', '/nettings', { body, token });

  const balancesOf = async (groupId: string, token = annToken): Promise<Record<string, number>> =>
    Object.fromEntries(
      (await call(app, 'GET', `/groups/${groupId}/balances`, { token })).body.map(
        (row: { memberId: string; balance: number }) => [row.memberId, row.balance],
      ),
    );

  beforeEach(async () => {
    database = temporaryDatabase();
    provider = await startFakeProvider();
    app = await startApplication(database.url, { providerUrl: provider.url, providerWebhookSecret: 'whsec_test' });
    ({ id: annId, token: annToken } = await accountOf(ada));
    ({ id: bobId, token: bobToken } = await accountOf(bobAccount));
    ({ id: outsiderId, token: outsiderToken } = await accountOf(outsiderAccount));
    // Bob is paid through the provider, on his payout account. Setting it asks the provider, which is not a payment.
    expect(
      (await call(app, 'PUT', '/accounts/me/payout-account', { body: { accountId: bobPayout }, token: bobToken }))
        .status,
    ).toBe(204);
    provider.requests.splice(0);
  });

  afterEach(async () => {
    for (const extra of extraApps.splice(0)) await extra.stop();
    await app.stop();
    await provider.stop();
    await database.remove();
  });

  /**
   * The example of the brief: Ann owes Bob 300 in the flat and 200 in the trip (created later), and Bob owes Ann 400 in the
   * club. Ann can pay 500, Bob 400: 400 is netted, Ann pays Bob 300 in the flat and 100 in the trip, Bob pays Ann 400 in the club.
   */
  async function theExample(): Promise<{ flat: string; trip: string; club: string }> {
    const flat = await makeGroup('The flat', 'EUR');
    await expense(flat, bobToken, 600);
    const trip = await makeGroup('The trip', 'EUR');
    await expense(trip, bobToken, 400);
    const club = await makeGroup('The club', 'EUR');
    await expense(club, annToken, 800);
    return { flat, trip, club };
  }

  describe('netting', () => {
    it('answers the id of a netting at once, and nets the example of the brief', async () => {
      const { flat, trip, club } = await theExample();
      expect(await balancesOf(flat)).toEqual({ [annId]: -300, [bobId]: 300 });
      expect(await balancesOf(trip)).toEqual({ [annId]: -200, [bobId]: 200 });
      expect(await balancesOf(club)).toEqual({ [annId]: 400, [bobId]: -400 });

      const answer = await net({ with: bobId, currency: 'EUR' }, annToken);
      expect(answer).toEqual({ status: 201, body: { id: expect.any(String) } });
      const netting = (await call(app, 'GET', `/nettings/${answer.body.id}`, { token: annToken })).body;
      expect(netting).toEqual({
        id: answer.body.id,
        by: annId,
        with: bobId,
        currency: 'EUR',
        amount: 400,
        settlements: [expect.any(String), expect.any(String), expect.any(String)],
      });
      const settlements = await Promise.all(
        netting.settlements.map((id: string) => call(app, 'GET', `/settlements/${id}`, { token: annToken })),
      );
      expect(settlements.map(reply => reply.status)).toEqual([200, 200, 200]);
      expect(settlements.map(reply => reply.body)).toEqual([
        {
          id: netting.settlements[0],
          groupId: flat,
          from: annId,
          to: bobId,
          amount: 300,
          method: 'net',
          status: 'paid',
          at: expect.stringMatching(AT_PATTERN),
          history: [{ status: 'paid', at: expect.stringMatching(AT_PATTERN) }],
        },
        {
          id: netting.settlements[1],
          groupId: trip,
          from: annId,
          to: bobId,
          amount: 100,
          method: 'net',
          status: 'paid',
          at: expect.stringMatching(AT_PATTERN),
          history: [{ status: 'paid', at: expect.stringMatching(AT_PATTERN) }],
        },
        {
          id: netting.settlements[2],
          groupId: club,
          from: bobId,
          to: annId,
          amount: 400,
          method: 'net',
          status: 'paid',
          at: expect.stringMatching(AT_PATTERN),
          history: [{ status: 'paid', at: expect.stringMatching(AT_PATTERN) }],
        },
      ]);
      expect(settlements[0].body).not.toHaveProperty('payUrl');
    });

    it('counts the settlements at once: the balances of each group move, and still add up to 0', async () => {
      const { flat, trip, club } = await theExample();
      await net({ with: bobId, currency: 'EUR' }, annToken);
      expect(await balancesOf(flat)).toEqual({ [annId]: 0, [bobId]: 0 });
      expect(await balancesOf(trip)).toEqual({ [annId]: -100, [bobId]: 100 });
      expect(await balancesOf(club)).toEqual({ [annId]: 0, [bobId]: 0 });
    });

    it('nets only the smaller total: the one who owes less pays all of it, and the other pays as much', async () => {
      const flat = await makeGroup('The flat', 'EUR');
      await expense(flat, bobToken, 200); // Ann owes Bob 100.
      const club = await makeGroup('The club', 'EUR');
      await expense(club, annToken, 800); // Bob owes Ann 400.
      const answer = await net({ with: bobId, currency: 'EUR' }, annToken);
      expect(answer.status).toBe(201);
      const netting = (await call(app, 'GET', `/nettings/${answer.body.id}`, { token: bobToken })).body;
      expect(netting.amount).toBe(100);
      expect(netting.settlements).toHaveLength(2);
      expect(await balancesOf(flat)).toEqual({ [annId]: 0, [bobId]: 0 });
      expect(await balancesOf(club)).toEqual({ [annId]: 300, [bobId]: -300 });
    });

    it('nets only in the currency asked: a group in another currency is left out', async () => {
      const flat = await makeGroup('The flat', 'EUR');
      await expense(flat, bobToken, 600); // Ann owes Bob 300 in euros.
      const club = await makeGroup('The club', 'EUR');
      await expense(club, annToken, 200); // Bob owes Ann 100 in euros.
      const usClub = await makeGroup('The US club', 'USD');
      await expense(usClub, annToken, 800); // Bob owes Ann 400 in dollars: not netted in euros.
      const answer = await net({ with: bobId, currency: 'EUR' }, annToken);
      expect(answer.status).toBe(201);
      const netting = (await call(app, 'GET', `/nettings/${answer.body.id}`, { token: annToken })).body;
      expect(netting).toMatchObject({ currency: 'EUR', amount: 100 });
      expect(await balancesOf(usClub)).toEqual({ [annId]: 400, [bobId]: -400 });
    });

    it('nets in the other direction when the other is the one who is owed', async () => {
      const { flat, trip, club } = await theExample();
      const answer = await net({ with: annId, currency: 'EUR' }, bobToken);
      expect(answer.status).toBe(201);
      const netting = (await call(app, 'GET', `/nettings/${answer.body.id}`, { token: bobToken })).body;
      expect(netting).toMatchObject({ by: bobId, with: annId, amount: 400 });
      expect(await balancesOf(flat)).toEqual({ [annId]: 0, [bobId]: 0 });
      expect(await balancesOf(trip)).toEqual({ [annId]: -100, [bobId]: 100 });
      expect(await balancesOf(club)).toEqual({ [annId]: 0, [bobId]: 0 });
    });

    it('records the settlements as made by the one who asked, in the audit of each group', async () => {
      const { flat, trip, club } = await theExample();
      const answer = await net({ with: bobId, currency: 'EUR' }, annToken);
      const netting = (await call(app, 'GET', `/nettings/${answer.body.id}`, { token: annToken })).body;
      const audit = async (groupId: string) =>
        (await call(app, 'GET', `/groups/${groupId}/audit`, { token: annToken })).body.filter(
          (entry: { action: string }) => entry.action === 'settlement-paid',
        );
      const flatEntries = await audit(flat);
      expect(flatEntries).toEqual([
        expect.objectContaining({
          by: annId,
          action: 'settlement-paid',
          subjectId: netting.settlements[0],
          amount: 300,
        }),
      ]);
      expect(await audit(trip)).toEqual([
        expect.objectContaining({
          by: annId,
          action: 'settlement-paid',
          subjectId: netting.settlements[1],
          amount: 100,
        }),
      ]);
      expect(await audit(club)).toEqual([
        // Bob's payment is the caller's netting too: the audit names the member who asked.
        expect.objectContaining({
          by: annId,
          action: 'settlement-paid',
          subjectId: netting.settlements[2],
          amount: 400,
        }),
      ]);
    });

    it('shows each netted settlement in the statement of its members, described as a settlement by netting', async () => {
      const { flat } = await theExample();
      await net({ with: bobId, currency: 'EUR' }, annToken);
      const statement = (await call(app, 'GET', `/groups/${flat}/members/${annId}/statement`, { token: annToken }))
        .body;
      expect(statement.entries).toEqual([
        expect.objectContaining({ kind: 'expense', paid: 0, share: 300, balance: -300 }),
        expect.objectContaining({
          kind: 'settlement',
          description: 'Settlement by netting',
          paid: 300,
          share: 0,
          balance: 0,
        }),
      ]);
    });

    it('never refunds a netted settlement: the payee is refused, and nothing changes', async () => {
      const { flat } = await theExample();
      const answer = await net({ with: bobId, currency: 'EUR' }, annToken);
      const netting = (await call(app, 'GET', `/nettings/${answer.body.id}`, { token: annToken })).body;
      const refund = await call(app, 'POST', `/settlements/${netting.settlements[0]}/refund`, { token: bobToken });
      expect(refund).toEqual({ status: 409, body: { type: 'NotRefundable', message: expect.any(String) } });
      expect(await balancesOf(flat)).toEqual({ [annId]: 0, [bobId]: 0 });
    });

    it('refuses a second netting once nothing is left to net, and changes nothing', async () => {
      await theExample();
      expect((await net({ with: bobId, currency: 'EUR' }, annToken)).status).toBe(201);
      // Ann still owes Bob 100 in the trip, and Bob owes Ann nothing.
      const again = await net({ with: bobId, currency: 'EUR' }, annToken);
      expect(again).toEqual({ status: 409, body: { type: 'NothingToNet', message: expect.any(String) } });
      expect(await countRows(database.url, 'nettings')).toBe(1);
      expect(await countRows(database.url, 'settlements')).toBe(3);
    });

    it('counts a payment waiting at the provider as paid, so there is nothing left for it to net', async () => {
      const flat = await makeGroup('The flat', 'EUR');
      await expense(flat, bobToken, 600); // Ann owes Bob 300.
      const club = await makeGroup('The club', 'EUR');
      await expense(club, annToken, 400); // Bob owes Ann 200.
      // Ann asks to pay Bob 300 through the provider: it waits, and counts as paid.
      const asked = await call(app, 'POST', `/groups/${flat}/settlements/provider`, {
        body: { to: bobId, amount: 300 },
        token: annToken,
      });
      expect(asked.status).toBe(201);
      expect(await net({ with: bobId, currency: 'EUR' }, annToken)).toEqual({
        status: 409,
        body: { type: 'NothingToNet', message: expect.any(String) },
      });
    });

    it('is decided on the balances the other left, when two nettings are asked at once, through two servers', async () => {
      const flat = await makeGroup('The flat', 'EUR');
      await expense(flat, bobToken, 600); // Ann owes Bob 300.
      const club = await makeGroup('The club', 'EUR');
      await expense(club, annToken, 400); // Bob owes Ann 200: 200 can be netted.
      const other = await startApplication(database.url, {
        providerUrl: provider.url,
        providerWebhookSecret: 'whsec_test',
      });
      extraApps.push(other);
      const [first, second] = await Promise.all([
        net({ with: bobId, currency: 'EUR' }, annToken),
        net({ with: bobId, currency: 'EUR' }, annToken, other),
      ]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);
      const refused = first.status === 409 ? first : second;
      expect(refused.body).toEqual({ type: 'NothingToNet', message: expect.any(String) });
      expect(await countRows(database.url, 'settlements')).toBe(2);
      expect(await balancesOf(flat)).toEqual({ [annId]: -100, [bobId]: 100 });
      expect(await balancesOf(club)).toEqual({ [annId]: 0, [bobId]: 0 });
    });

    it('is decided on what a cash settlement left, when the two are asked at once', async () => {
      const flat = await makeGroup('The flat', 'EUR');
      await expense(flat, bobToken, 600); // Ann owes Bob 300.
      const club = await makeGroup('The club', 'EUR');
      await expense(club, annToken, 400); // Bob owes Ann 200.
      const [netted, cash] = await Promise.all([
        net({ with: bobId, currency: 'EUR' }, annToken),
        call(app, 'POST', `/groups/${flat}/settlements/cash`, { body: { from: annId, amount: 300 }, token: bobToken }),
      ]);
      // Either the netting came first and leaves Ann owing 100, so the cash of 300 is refused; or the cash came first and
      // leaves nothing for the netting to net. Never more than is owed.
      if (netted.status === 201) {
        expect(cash.status).toBe(409);
        expect(await balancesOf(flat)).toEqual({ [annId]: -100, [bobId]: 100 });
        expect(await balancesOf(club)).toEqual({ [annId]: 0, [bobId]: 0 });
      } else {
        expect([netted.status, cash.status]).toEqual([409, 201]);
        expect(await balancesOf(flat)).toEqual({ [annId]: 0, [bobId]: 0 });
        expect(await balancesOf(club)).toEqual({ [annId]: 200, [bobId]: -200 });
      }
    });
  });

  describe('refusals', () => {
    it('refuses a netting with oneself, and changes nothing', async () => {
      await theExample();
      const answer = await net({ with: annId, currency: 'EUR' }, annToken);
      expect(answer).toEqual({ status: 422, body: { type: 'SameAccount', message: expect.any(String) } });
      expect(await countRows(database.url, 'nettings')).toBe(0);
    });

    it('refuses a currency that is not one of Tally’s, and changes nothing', async () => {
      await theExample();
      const answer = await net({ with: bobId, currency: 'SEK' }, annToken);
      expect(answer).toEqual({ status: 422, body: { type: 'InvalidCurrency', message: expect.any(String) } });
      expect(await countRows(database.url, 'nettings')).toBe(0);
    });

    it('refuses a netting with someone with whom there is nothing to net, and changes nothing', async () => {
      const flat = await makeGroup('The flat', 'EUR');
      await expense(flat, bobToken, 600); // Only Ann owes: Bob owes Ann nothing anywhere.
      const answer = await net({ with: bobId, currency: 'EUR' }, annToken);
      expect(answer).toEqual({ status: 409, body: { type: 'NothingToNet', message: expect.any(String) } });
      expect(await balancesOf(flat)).toEqual({ [annId]: -300, [bobId]: 300 });
      expect(await countRows(database.url, 'settlements')).toBe(0);
    });

    it('refuses a netting with someone with whom the caller shares no group', async () => {
      await theExample();
      const answer = await net({ with: outsiderId, currency: 'EUR' }, annToken);
      expect(answer).toEqual({ status: 409, body: { type: 'NothingToNet', message: expect.any(String) } });
    });

    it('refuses a netting of someone who is not signed in', async () => {
      await theExample();
      const answer = await call(app, 'POST', '/nettings', { body: { with: bobId, currency: 'EUR' } });
      expect(answer.status).toBe(401);
      expect(await countRows(database.url, 'nettings')).toBe(0);
    });

    it('refuses a netting whose body is incomplete', async () => {
      await theExample();
      expect((await call(app, 'POST', '/nettings', { body: { with: bobId }, token: annToken })).status).toBe(400);
    });
  });

  describe('reading a netting', () => {
    it('lets both of the two people read it, and answers it to no one else', async () => {
      await theExample();
      const { body } = await net({ with: bobId, currency: 'EUR' }, annToken);
      expect((await call(app, 'GET', `/nettings/${body.id}`, { token: annToken })).status).toBe(200);
      expect((await call(app, 'GET', `/nettings/${body.id}`, { token: bobToken })).status).toBe(200);
      expect((await call(app, 'GET', `/nettings/${body.id}`, { token: outsiderToken })).status).toBe(404);
    });

    it('answers the settlements in the order they were made', async () => {
      await theExample();
      const { body } = await net({ with: bobId, currency: 'EUR' }, annToken);
      const netting = (await call(app, 'GET', `/nettings/${body.id}`, { token: bobToken })).body;
      const rows = await readRows(database.url, 'SELECT id, payer_id, amount FROM settlements ORDER BY seq');
      expect(netting.settlements).toEqual(rows.map(row => row.id));
    });

    it('answers no netting for an id that is not one, or without a signed-in account', async () => {
      expect((await call(app, 'GET', '/nettings/no-such-netting', { token: annToken })).status).toBe(404);
      expect((await call(app, 'GET', '/nettings/no-such-netting')).status).toBe(401);
    });
  });
});
