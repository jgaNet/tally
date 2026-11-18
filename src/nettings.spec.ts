import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Application, createApplication } from './app';
import { type Database, openDatabase } from './database';
import { ensureDatabase, send, signedUpAccount, testDirectory, type TestDirectory } from './test-helpers';

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

const SECRET = 'shared with the provider';

describe('netting what two people owe each other across their groups', () => {
  let directory: TestDirectory;
  let app: Application;
  let db: Database;
  let provider: Server;
  let payments: number;

  beforeEach(async () => {
    directory = testDirectory();
    payments = 0;
    // A fake provider: it knows every payout account, and answers each payment request with a payment and its link.
    provider = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        if (request.url?.startsWith('/accounts/')) {
          const id = decodeURIComponent(request.url.slice('/accounts/'.length));
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ id }));
          return;
        }
        payments += 1;
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: `pay_${payments}`, payUrl: `https://pay.example.org/${payments}`, fee: 0 }));
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    await ensureDatabase(directory.databaseUrl);
    app = await createApplication({
      databaseUrl: directory.databaseUrl,
      providerUrl,
      providerWebhookSecret: SECRET,
      providerTimeoutMs: 2000,
    });
    await app.start(0);
    // A second connection to the same database, to count what was stored.
    db = await openDatabase({ url: directory.databaseUrl });
  });

  afterEach(async () => {
    await db.close();
    await app.stop();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    provider.closeAllConnections();
    await directory.remove();
  });

  /** Creates a group as `token`'s account, in `currency`, and answers its id. */
  async function createGroup(token: string, name: string, currency = 'EUR'): Promise<string> {
    const reply = await send(app, 'POST', '/groups', { token, body: { name, currency } });
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

  /** Records a dinner paid by `token`'s account, split equally between `splitBetween`. */
  async function dinner(token: string, groupId: string, amount: number, splitBetween: string[]): Promise<void> {
    const reply = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      body: { description: 'Dinner', amount, date: utcDay(0), splitBetween },
    });
    if (reply.status !== 201) throw new Error(`record answered ${reply.status}`);
  }

  /** The balances of `groupId`, read as `token`'s account, as a map from member to balance. */
  async function balancesAs(token: string, groupId: string): Promise<Record<string, number>> {
    const reply = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    const rows = reply.body as { memberId: string; balance: number }[];
    return Object.fromEntries(rows.map(row => [row.memberId, row.balance]));
  }

  /** Asks Tally to net `token`'s account with `with` in `currency`. */
  async function net(token: string, withId: string, currency = 'EUR') {
    return send(app, 'POST', '/nettings', { token, body: { with: withId, currency } });
  }

  /**
   * Ann and Ben, who owe each other as the example of the feature says: Ann owes Ben 300 in the flat (created first) and
   * 200 in the trip (created later), and Ben owes Ann 400 in the club. Answers the accounts and the groups.
   */
  async function annAndBenAcrossThreeGroups() {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const flat = await createGroup(ann.token, 'Flat');
    await join(ann.token, flat, ben.token);
    await dinner(ben.token, flat, 600, [ann.id, ben.id]);
    const trip = await createGroup(ann.token, 'Trip');
    await join(ann.token, trip, ben.token);
    await dinner(ben.token, trip, 400, [ann.id, ben.id]);
    const club = await createGroup(ann.token, 'Club');
    await join(ann.token, club, ben.token);
    await dinner(ann.token, club, 800, [ann.id, ben.id]);
    return { ann, ben, flat, trip, club };
  }

  it('nets the smaller of what each can pay, group by group, the earliest group first, and reads it back', async () => {
    const { ann, ben, flat, trip, club } = await annAndBenAcrossThreeGroups();
    // Ann can pay 300 + 200 = 500, Ben can pay 400: 400 is netted, Ann pays 300 in the flat and 100 in the trip, Ben 400.
    const asked = await net(ann.token, ben.id);
    expect(asked.status).toBe(201);
    const id = (asked.body as { id: string }).id;

    const read = await send(app, 'GET', `/nettings/${id}`, { token: ann.token });
    expect(read.status).toBe(200);
    const settlements = (read.body as { settlements: string[] }).settlements;
    expect(read.body).toEqual({
      id,
      by: ann.id,
      with: ben.id,
      currency: 'EUR',
      amount: 400,
      settlements: [expect.any(String), expect.any(String), expect.any(String)],
    });
    expect(settlements).toHaveLength(3);
    const [first, second, third] = await Promise.all(
      settlements.map(
        async settlement => (await send(app, 'GET', `/settlements/${settlement}`, { token: ann.token })).body,
      ),
    );
    const at = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(first).toEqual({
      id: settlements[0],
      groupId: flat,
      from: ann.id,
      to: ben.id,
      amount: 300,
      method: 'net',
      status: 'paid',
      at,
      history: [{ status: 'paid', at }],
    });
    expect(second).toMatchObject({
      id: settlements[1],
      groupId: trip,
      from: ann.id,
      to: ben.id,
      amount: 100,
      method: 'net',
      status: 'paid',
    });
    expect(third).toMatchObject({
      id: settlements[2],
      groupId: club,
      from: ben.id,
      to: ann.id,
      amount: 400,
      method: 'net',
      status: 'paid',
    });
    expect(first).not.toHaveProperty('payUrl');
  });

  it('reads the same netting to the other member, and to anyone else it does not exist', async () => {
    const { ann, ben } = await annAndBenAcrossThreeGroups();
    const id = (await net(ann.token, ben.id)).body as { id: string };
    const asAnn = await send(app, 'GET', `/nettings/${id.id}`, { token: ann.token });
    const asBen = await send(app, 'GET', `/nettings/${id.id}`, { token: ben.token });
    expect(asBen.status).toBe(200);
    expect(asBen.body).toEqual(asAnn.body);
    const stranger = await signedUpAccount(app, { email: 'cy@example.org', name: 'Cy' });
    const asStranger = await send(app, 'GET', `/nettings/${id.id}`, { token: stranger.token });
    expect(asStranger.status).toBe(404);
    expect(asStranger.body).toMatchObject({ error: 'NettingNotFound' });
    expect((await send(app, 'GET', `/nettings/${id.id}`, { token: undefined })).status).toBe(401);
    expect((await send(app, 'GET', '/nettings/no-such-netting', { token: ann.token })).status).toBe(404);
  });

  it('counts the settlements at once, in the balances, the suggestions, the group’s settlements, the audit and the statement', async () => {
    const { ann, ben, flat, trip, club } = await annAndBenAcrossThreeGroups();
    const id = ((await net(ann.token, ben.id)).body as { id: string }).id;
    const { settlements } = (await send(app, 'GET', `/nettings/${id}`, { token: ben.token })).body as {
      settlements: string[];
    };

    expect(await balancesAs(ben.token, flat)).toEqual({ [ann.id]: 0, [ben.id]: 0 });
    expect(await balancesAs(ben.token, trip)).toEqual({ [ann.id]: -100, [ben.id]: 100 });
    expect(await balancesAs(ben.token, club)).toEqual({ [ann.id]: 0, [ben.id]: 0 });
    const suggested = await send(app, 'GET', `/groups/${trip}/settlements/suggested`, { token: ann.token });
    expect(suggested.body).toEqual([{ from: ann.id, to: ben.id, amount: 100 }]);

    const listed = await send(app, 'GET', `/groups/${club}/settlements`, { token: ann.token });
    expect(listed.body).toEqual([
      expect.objectContaining({ id: settlements[2], method: 'net', status: 'paid', from: ben.id }),
    ]);

    const audit = await send(app, 'GET', `/groups/${flat}/audit`, { token: ann.token });
    expect((audit.body as { action: string }[]).map(entry => entry.action)).toEqual([
      'expense-recorded',
      'settlement-paid',
    ]);
    expect(audit.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'settlement-paid', by: ann.id, subjectId: settlements[0], amount: 300 }),
      ]),
    );

    const statement = await send(app, 'GET', `/groups/${flat}/members/${ann.id}/statement`, { token: ann.token });
    expect(statement.body).toMatchObject({
      balance: 0,
      entries: [
        expect.objectContaining({ kind: 'expense', paid: 0, share: 300, balance: -300 }),
        {
          kind: 'settlement',
          settlementId: settlements[0],
          date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          description: 'Settlement by netting',
          paid: 300,
          share: 0,
          balance: 0,
        },
      ],
    });
  });

  it('counts a payment waiting at the provider as paid, as the balances do', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const flat = await createGroup(ann.token, 'Flat');
    await join(ann.token, flat, ben.token);
    // Ben paid 3000 split equally: Ann owes Ben 1500, and Ben is paid through the provider, so has a payout account.
    await dinner(ben.token, flat, 3000, [ann.id, ben.id]);
    expect(
      (await send(app, 'PUT', '/accounts/me/payout-account', { token: ben.token, body: { accountId: 'acct_ben' } }))
        .status,
    ).toBe(204);
    const club = await createGroup(ann.token, 'Club');
    await join(ann.token, club, ben.token);
    // Ann paid 2000 split equally: Ben owes Ann 1000.
    await dinner(ann.token, club, 2000, [ann.id, ben.id]);
    // Ann asks the provider for 1000 to Ben in the flat: still pending, and counted as paid: Ann owes 500 there now.
    const pending = await send(app, 'POST', `/groups/${flat}/settlements/provider`, {
      token: ann.token,
      body: { to: ben.id, amount: 1000 },
    });
    expect(pending.status).toBe(201);

    const asked = await net(ann.token, ben.id);
    expect(asked.status).toBe(201);
    const { amount, settlements } = (
      await send(app, 'GET', `/nettings/${(asked.body as { id: string }).id}`, { token: ann.token })
    ).body as {
      amount: number;
      settlements: string[];
    };
    expect(amount).toBe(500);
    expect(settlements).toHaveLength(2);
    const paidBy = await Promise.all(
      settlements.map(
        async settlement => (await send(app, 'GET', `/settlements/${settlement}`, { token: ann.token })).body,
      ),
    );
    expect(paidBy).toEqual([
      expect.objectContaining({ groupId: flat, from: ann.id, to: ben.id, amount: 500, method: 'net', status: 'paid' }),
      expect.objectContaining({ groupId: club, from: ben.id, to: ann.id, amount: 500, method: 'net', status: 'paid' }),
    ]);
    // The balances leave a pending payment out until the provider says it is paid: Ann owes 1500, less the 500 netted.
    expect(await balancesAs(ann.token, flat)).toEqual({ [ann.id]: -1000, [ben.id]: 1000 });
    expect(await db.prepare("SELECT status FROM settlements WHERE method = 'provider'").get()).toEqual({
      status: 'pending',
    });
  });

  it('refuses a netting with nothing to net, and changes nothing', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const flat = await createGroup(ann.token, 'Flat');
    await join(ann.token, flat, ben.token);
    await dinner(ben.token, flat, 600, [ann.id, ben.id]);
    // Only Ann owes Ben: Ben owes Ann nothing, so nothing nets.
    const refused = await net(ann.token, ben.id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'NothingToNet' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM settlements').get()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM nettings').get()).toEqual({ n: 0 });
    expect(await balancesAs(ann.token, flat)).toEqual({ [ann.id]: -300, [ben.id]: 300 });
  });

  it('refuses a netting with oneself, in a currency that is not Tally’s, and with someone with whom nothing is owed', async () => {
    const { ann, ben } = await annAndBenAcrossThreeGroups();
    const stranger = await signedUpAccount(app, { email: 'cy@example.org', name: 'Cy' });
    const withSelf = await net(ann.token, ann.id);
    expect(withSelf.status).toBe(422);
    expect(withSelf.body).toMatchObject({ error: 'NettingWithSelf' });
    const unknownCurrency = await net(ann.token, ben.id, 'JPY');
    expect(unknownCurrency.status).toBe(422);
    expect(unknownCurrency.body).toMatchObject({ error: 'CurrencyIsUnsupported' });
    const noGroupTogether = await net(ann.token, stranger.id);
    expect(noGroupTogether.status).toBe(409);
    expect(noGroupTogether.body).toMatchObject({ error: 'NothingToNet' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM settlements').get()).toEqual({ n: 0 });
  });

  it('asks for a signed-in caller', async () => {
    const { ben } = await annAndBenAcrossThreeGroups();
    const reply = await send(app, 'POST', '/nettings', { body: { with: ben.id, currency: 'EUR' } });
    expect(reply.status).toBe(401);
    expect(reply.body).toMatchObject({ error: 'NotSignedIn' });
  });

  it('counts only the groups the two members are both current members of, in the currency, and not archived', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    // A group in another currency, where Ann owes Ben: not netted in euros.
    const usd = await createGroup(ann.token, 'Holiday', 'USD');
    await join(ann.token, usd, ben.token);
    await dinner(ben.token, usd, 600, [ann.id, ben.id]);
    // A group in euros where Ben owes Ann: Ann can pay nothing there, so the group where Ben owes Ann is the only one.
    const club = await createGroup(ann.token, 'Club');
    await join(ann.token, club, ben.token);
    await dinner(ann.token, club, 600, [ann.id, ben.id]);
    // Ben leaves the club: what he is owed passes to Ann, and the club is no longer one they share.
    expect((await send(app, 'POST', `/groups/${club}/leave`, { token: ben.token })).status).toBe(204);
    const refused = await net(ann.token, ben.id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'NothingToNet' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM settlements').get()).toEqual({ n: 0 });
  });

  it('leaves an archived group out: the netting is made in the live groups only', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    // The flat is archived with every balance 0, as archiving needs: it can owe nothing, so nothing nets in it.
    const flat = await createGroup(ann.token, 'Flat');
    await join(ann.token, flat, ben.token);
    await dinner(ben.token, flat, 600, [ann.id, ben.id]);
    await dinner(ann.token, flat, 600, [ann.id, ben.id]);
    expect(await balancesAs(ann.token, flat)).toEqual({ [ann.id]: 0, [ben.id]: 0 });
    expect((await send(app, 'POST', `/groups/${flat}/archive`, { token: ann.token })).status).toBe(204);
    // Two live groups: Ben owes Ann 300 in one, Ann owes Ben 300 in the other.
    const owesAnn = await createGroup(ann.token, 'Club');
    await join(ann.token, owesAnn, ben.token);
    await dinner(ann.token, owesAnn, 600, [ann.id, ben.id]);
    const owesBen = await createGroup(ann.token, 'Gym');
    await join(ann.token, owesBen, ben.token);
    await dinner(ben.token, owesBen, 600, [ann.id, ben.id]);
    const asked = await net(ann.token, ben.id);
    expect(asked.status).toBe(201);
    const { amount, settlements } = (
      await send(app, 'GET', `/nettings/${(asked.body as { id: string }).id}`, { token: ann.token })
    ).body as {
      amount: number;
      settlements: string[];
    };
    expect(amount).toBe(300);
    const groups = await Promise.all(
      settlements.map(
        async settlement => (await send(app, 'GET', `/settlements/${settlement}`, { token: ann.token })).body,
      ),
    );
    expect(groups.map(settlement => (settlement as { groupId: string }).groupId)).toEqual([owesBen, owesAnn]);
    // The archived group stays read only: nothing is recorded in it.
    expect(await db.prepare('SELECT COUNT(*) AS n FROM settlements WHERE group_id = ?').get(flat)).toEqual({ n: 0 });
  });

  it('is never refunded: a netting’s settlement is refused a refund, and stays paid', async () => {
    const { ann, ben } = await annAndBenAcrossThreeGroups();
    const id = ((await net(ann.token, ben.id)).body as { id: string }).id;
    const { settlements } = (await send(app, 'GET', `/nettings/${id}`, { token: ben.token })).body as {
      settlements: string[];
    };
    const refund = await send(app, 'POST', `/settlements/${settlements[0]}/refund`, { token: ben.token });
    expect(refund.status).toBe(409);
    expect(refund.body).toMatchObject({ error: 'NotPaidThroughProvider' });
    expect((await send(app, 'GET', `/settlements/${settlements[0]}`, { token: ben.token })).body).toMatchObject({
      status: 'paid',
    });
  });

  it('nets once when two nettings are asked at the same moment: the other is decided on what was left', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const flat = await createGroup(ann.token, 'Flat');
    await join(ann.token, flat, ben.token);
    await dinner(ben.token, flat, 600, [ann.id, ben.id]);
    const club = await createGroup(ann.token, 'Club');
    await join(ann.token, club, ben.token);
    await dinner(ann.token, club, 600, [ann.id, ben.id]);

    const [byAnn, byBen] = await Promise.all([net(ann.token, ben.id), net(ben.token, ann.id)]);
    expect([byAnn.status, byBen.status].sort()).toEqual([201, 409]);
    const refused = byAnn.status === 409 ? byAnn : byBen;
    expect(refused.body).toMatchObject({ error: 'NothingToNet' });
    // One netting made its two settlements; no settlement pays more than is owed.
    expect(await db.prepare('SELECT COUNT(*) AS n FROM settlements').get()).toEqual({ n: 2 });
    expect(await balancesAs(ann.token, flat)).toEqual({ [ann.id]: 0, [ben.id]: 0 });
    expect(await balancesAs(ann.token, club)).toEqual({ [ann.id]: 0, [ben.id]: 0 });
  });

  it('decides a netting and a cash settlement asked at the same moment on what the other left', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const flat = await createGroup(ann.token, 'Flat');
    await join(ann.token, flat, ben.token);
    await dinner(ben.token, flat, 600, [ann.id, ben.id]);
    const club = await createGroup(ann.token, 'Club');
    await join(ann.token, club, ben.token);
    await dinner(ann.token, club, 600, [ann.id, ben.id]);

    const [netted, paidInCash] = await Promise.all([
      net(ann.token, ben.id),
      send(app, 'POST', `/groups/${flat}/settlements/cash`, { token: ben.token, body: { from: ann.id, amount: 300 } }),
    ]);
    // Either the cash settlement first (Ann owes nothing then, so nothing nets), or the netting first (so the cash
    // settlement pays more than is owed): one is made and the other refused.
    expect([netted.status, paidInCash.status].sort()).toEqual([201, 409]);
    expect(await balancesAs(ann.token, flat)).toEqual({ [ann.id]: 0, [ben.id]: 0 });
  });

  it('refuses a payment when the netting has left nothing to pay, as the balances do', async () => {
    // The netting's payments are settlements like any other: a later one may not pay more than is owed.
    const { ann, ben, flat } = await annAndBenAcrossThreeGroups();
    expect((await net(ann.token, ben.id)).status).toBe(201);
    const late = await send(app, 'POST', `/groups/${flat}/settlements/cash`, {
      token: ben.token,
      body: { from: ann.id, amount: 1 },
    });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ error: 'AmountExceedsBalance' });
  });
});
