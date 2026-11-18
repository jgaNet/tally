import { Application } from './app';
import { ada, call, FakeProvider, startApplication, startFakeProvider, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const sam = { email: 'sam@example.com', password: 'sam-password-1', name: 'Sam' };
const rita = { email: 'rita@example.com', password: 'rita-password-1', name: 'Rita' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };

const DATE = '2026-11-01';
const SECRET = 'whsec_test';
const adaPayout = 'acct_ada';

interface Listed {
  memberId: string;
  balance: number;
}

/** The balances of a group as a map from each listed member to the balance it is listed with. */
function asMap(rows: Listed[]): Map<string, number> {
  return new Map(rows.map(row => [row.memberId, row.balance]));
}

describe('merging two groups', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let provider: FakeProvider;
  let app: Application;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;
  let samId: string;
  let samToken: string;
  let ritaId: string;
  let ritaToken: string;
  let outsiderToken: string;
  // The group kept, and the group merged into it: both are Ada's, in euros.
  let flat: string;
  let rent: string;

  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  async function createGroup(token: string, name: string, currency = 'EUR'): Promise<string> {
    const answer = await call(app, 'POST', '/groups', { body: { name, currency }, token });
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  /** Brings the account into the group by an invitation made by `inviterToken`. */
  async function join(groupId: string, accountToken: string, inviterToken = adaToken): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: inviterToken });
    expect(invitation.status).toBe(201);
    const answer = await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken });
    expect(answer.status).toBe(204);
  }

  const record = (groupId: string, token: string, fields: Record<string, unknown> = {}) =>
    call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 3000, date: DATE, splitBetween: [adaId, graceId, linusId], ...fields },
      token,
    });

  async function recordedIn(groupId: string, fields: Record<string, unknown> = {}): Promise<string> {
    const answer = await record(groupId, adaToken, fields);
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  const balances = (groupId: string, token = adaToken) => call(app, 'GET', `/groups/${groupId}/balances`, { token });

  const merge = (kept: string, from: string, token = adaToken) =>
    call(app, 'POST', `/groups/${kept}/merge`, { body: { from }, token });

  /**
   * Merges `rent` into `flat`, after checking that every member's balance in `flat` is what it was in `flat` plus what
   * it was in `rent`, and that the balances add up to 0 both before and after.
   */
  async function mergeAndCheckBalances(): Promise<void> {
    const before = [asMap((await balances(flat)).body), asMap((await balances(rent)).body)];
    expect(sumOf(before[0])).toBe(0);
    expect(sumOf(before[1])).toBe(0);
    expect((await merge(flat, rent)).status).toBe(204);
    const after = asMap((await balances(flat)).body);
    expect(sumOf(after)).toBe(0);
    const members = new Set([...before[0].keys(), ...before[1].keys(), ...after.keys()]);
    for (const memberId of members) {
      if (!after.has(memberId)) continue;
      expect(after.get(memberId)).toBe((before[0].get(memberId) ?? 0) + (before[1].get(memberId) ?? 0));
    }
  }

  function sumOf(map: Map<string, number>): number {
    return [...map.values()].reduce((sum, value) => sum + value, 0);
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    app = await startApplication(database.url);
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
    ({ id: samId, token: samToken } = await accountOf(sam));
    ({ id: ritaId, token: ritaToken } = await accountOf(rita));
    ({ token: outsiderToken } = await accountOf(outsiderAccount));
    flat = await createGroup(adaToken, 'The flat');
    await join(flat, graceToken);
    await join(flat, linusToken);
    rent = await createGroup(adaToken, 'Rent');
    await join(rent, graceToken);
    await join(rent, samToken);
  });

  afterEach(async () => {
    await app.stop();
    await database.remove();
  });

  it('keeps the group kept, and adds the balances of both to its members, with every member at 0 in sum', async () => {
    await recordedIn(flat);
    await recordedIn(rent, { description: 'Rent', amount: 1200, splitBetween: [adaId, graceId, samId] });
    await mergeAndCheckBalances();
    expect((await balances(flat)).body).toEqual([
      { memberId: adaId, balance: 2800 },
      { memberId: graceId, balance: -1400 },
      { memberId: linusId, balance: -1000 },
      { memberId: samId, balance: -400 },
    ]);
  });

  it('moves the expenses with their id and content, and reads them in the group kept', async () => {
    const dinner = await recordedIn(flat);
    const rentId = await recordedIn(rent, { description: 'Rent', amount: 1200, splitBetween: [adaId, graceId] });
    expect(
      (
        await call(app, 'PUT', `/expenses/${rentId}`, {
          body: {
            description: 'Rent, November',
            amount: 1200,
            date: DATE,
            splitBetween: [adaId, graceId],
            version: 1,
            category: 'rent',
          },
          token: adaToken,
        })
      ).status,
    ).toBe(204);
    const before = (await call(app, 'GET', `/expenses/${rentId}`, { token: adaToken })).body;
    expect(before).toMatchObject({ version: 2, category: 'rent', paidBy: adaId });

    expect((await merge(flat, rent)).status).toBe(204);

    const moved = (await call(app, 'GET', `/expenses/${rentId}`, { token: adaToken })).body;
    expect(moved).toEqual({ ...before, groupId: flat });
    const listed = (await call(app, 'GET', `/groups/${flat}/expenses`, { token: adaToken })).body;
    expect(listed.map((expense: { id: string }) => expense.id).sort()).toEqual([dinner, rentId].sort());
  });

  it('moves the settlements and the audit of the group merged, which keep their ids', async () => {
    await recordedIn(rent, { splitBetween: [adaId, graceId] });
    const cash = await call(app, 'POST', `/groups/${rent}/settlements/cash`, {
      body: { from: graceId, amount: 1500 },
      token: adaToken,
    });
    expect(cash.status).toBe(201);
    const settlementId = cash.body.id;
    await mergeAndCheckBalances();

    const settlements = (await call(app, 'GET', `/groups/${flat}/settlements`, { token: adaToken })).body;
    expect(settlements).toEqual([expect.objectContaining({ id: settlementId, groupId: flat, status: 'paid' })]);
    const audit = (await call(app, 'GET', `/groups/${flat}/audit`, { token: adaToken })).body;
    expect(audit).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'settlement-paid', subjectId: settlementId })]),
    );
  });

  it('adds the members of the group merged to the group kept, as members, after the ones it has', async () => {
    await mergeAndCheckBalances();
    expect((await call(app, 'GET', `/groups/${flat}/members`, { token: adaToken })).body).toEqual([
      { memberId: adaId, name: 'Ada Lovelace', role: 'owner', joinedAt: expect.any(String) },
      { memberId: graceId, name: 'Grace Hopper', role: 'member', joinedAt: expect.any(String) },
      { memberId: linusId, name: 'Linus Torvalds', role: 'member', joinedAt: expect.any(String) },
      { memberId: samId, name: 'Sam', role: 'member', joinedAt: expect.any(String) },
    ]);
  });

  it('adds a member of the group merged in the order they joined it, after the members of the group kept', async () => {
    await join(rent, ritaToken);
    await mergeAndCheckBalances();
    const members = (await call(app, 'GET', `/groups/${flat}/members`, { token: adaToken })).body;
    expect(members.map((member: { memberId: string }) => member.memberId)).toEqual([
      adaId,
      graceId,
      linusId,
      samId,
      ritaId,
    ]);
  });

  it('keeps a former member of the group merged as a former member of the group kept, with the balance they left with', async () => {
    await recordedIn(rent, { splitBetween: [adaId, graceId, samId] });
    expect((await call(app, 'POST', `/groups/${rent}/leave`, { token: samToken })).status).toBe(204);
    await mergeAndCheckBalances();
    expect(
      (await call(app, 'GET', `/groups/${flat}/members`, { token: adaToken })).body.map(
        (member: { memberId: string }) => member.memberId,
      ),
    ).not.toContain(samId);
    const statement = await call(app, 'GET', `/groups/${flat}/members/${samId}/statement`, { token: adaToken });
    expect(statement.status).toBe(200);
    expect(statement.body).toMatchObject({ memberId: samId, balance: -1000 });
    expect((await call(app, 'GET', `/groups/${flat}`, { token: samToken })).status).toBe(404);
  });

  it('brings a former member of the group kept who is active in the group merged back, with what the group merged owes them', async () => {
    await recordedIn(flat);
    await recordedIn(rent, { splitBetween: [adaId, graceId, samId] });
    expect((await call(app, 'POST', `/groups/${flat}/leave`, { token: graceToken })).status).toBe(204);
    await mergeAndCheckBalances();
    expect((await balances(flat)).body).toEqual(
      expect.arrayContaining([expect.objectContaining({ memberId: graceId })]),
    );
  });

  it('keeps a member of both who left the group merged in the group kept, and the owner keeps what they left with', async () => {
    await recordedIn(rent, { splitBetween: [adaId, graceId, samId] });
    expect((await call(app, 'POST', `/groups/${rent}/leave`, { token: graceToken })).status).toBe(204);
    await recordedIn(flat, { splitBetween: [adaId, graceId] });
    await mergeAndCheckBalances();
    const after = (await balances(flat)).body;
    expect(after).toEqual(expect.arrayContaining([expect.objectContaining({ memberId: graceId })]));
    expect((await call(app, 'GET', `/groups/${flat}/members`, { token: graceToken })).status).toBe(200);
  });

  it('moves the recurring expenses of the group merged to the group kept', async () => {
    const answer = await call(app, 'POST', `/groups/${rent}/recurring`, {
      body: { description: 'Gym', amount: 1001, startsOn: '2026-12-01', splitBetween: [adaId, graceId] },
      token: adaToken,
    });
    expect(answer.status).toBe(201);
    await mergeAndCheckBalances();
    expect((await call(app, 'GET', `/recurring/${answer.body.id}`, { token: adaToken })).body).toMatchObject({
      id: answer.body.id,
      groupId: flat,
    });
    const listed = (await call(app, 'GET', `/groups/${flat}/recurring`, { token: adaToken })).body;
    expect(listed.map((recurring: { id: string }) => recurring.id)).toEqual([answer.body.id]);
  });

  it('keeps the debt a member is noted for in the group merged: the reminder comes a period after the note, as it would have', async () => {
    const now = Date.parse('2026-11-01T10:00:00.000Z');
    const week = 7 * 24 * 3600 * 1000;
    // Grace owes 2500 in the group merged, a debt over 2000: the job notes it.
    await call(app, 'POST', `/groups/${rent}/expenses`, {
      body: { description: 'Rent', amount: 5000, date: DATE, splitBetween: [adaId, graceId] },
      token: adaToken,
    });
    await app.runJobs(new Date(now));
    await mergeAndCheckBalances();
    await app.runJobs(new Date(now + week));
    const reminders = (await call(app, 'GET', '/notices', { token: graceToken })).body.filter(
      (notice: { kind: string }) => notice.kind === 'reminder',
    );
    expect(reminders).toEqual([expect.objectContaining({ kind: 'reminder', groupId: flat, amount: 2500 })]);
  });

  it('no longer has the group merged for anyone, and its invitations let no one join', async () => {
    const invitation = await call(app, 'POST', `/groups/${rent}/invitations`, { token: adaToken });
    await mergeAndCheckBalances();
    expect((await call(app, 'GET', `/groups/${rent}`, { token: adaToken })).status).toBe(404);
    expect((await call(app, 'GET', `/groups/${rent}/balances`, { token: adaToken })).status).toBe(404);
    expect(
      (await call(app, 'GET', '/groups/mine', { token: samToken })).body.map((group: { id: string }) => group.id),
    ).toEqual([flat]);
    expect((await call(app, 'GET', `/invitations/${invitation.body.id}`, { token: linusToken })).status).toBe(404);
    expect((await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: linusToken })).status).toBe(
      404,
    );
  });

  it('refuses any change to the group merged once it is gone', async () => {
    await mergeAndCheckBalances();
    expect((await record(rent, adaToken)).body).toMatchObject({ type: 'NotFound' });
    expect(
      (
        await call(app, 'POST', `/groups/${rent}/settlements/cash`, {
          body: { from: graceId, amount: 100 },
          token: adaToken,
        })
      ).status,
    ).toBe(404);
    expect((await call(app, 'POST', `/groups/${rent}/leave`, { token: graceToken })).status).toBe(404);
    expect((await call(app, 'POST', `/groups/${rent}/archive`, { token: adaToken })).status).toBe(404);
    expect(
      (await call(app, 'PUT', `/groups/${rent}/budgets/food`, { body: { amount: 100 }, token: adaToken })).status,
    ).toBe(404);
  });

  it('keeps the budgets of the group kept, and drops those of the group merged', async () => {
    expect(
      (await call(app, 'PUT', `/groups/${rent}/budgets/rent`, { body: { amount: 50000 }, token: adaToken })).status,
    ).toBe(204);
    await mergeAndCheckBalances();
    expect((await call(app, 'GET', `/groups/${flat}/budgets`, { token: adaToken })).body).toEqual([]);
  });

  it('is refused when the caller does not own both groups, and nothing changes', async () => {
    const trip = await createGroup(graceToken, 'Trip');
    await join(trip, adaToken, graceToken);
    const before = (await balances(flat)).body;
    expect(await merge(flat, trip, adaToken)).toMatchObject({ status: 403, body: { type: 'NotAllowed' } });
    expect(await merge(trip, flat, graceToken)).toMatchObject({ status: 403, body: { type: 'NotAllowed' } });
    expect((await balances(flat)).body).toEqual(before);
    expect((await call(app, 'GET', `/groups/${trip}`, { token: graceToken })).status).toBe(200);
  });

  it('is refused for a group merged into itself', async () => {
    expect(await merge(flat, flat)).toMatchObject({ status: 422, body: { type: 'SameGroup' } });
  });

  it('is refused for groups of different currencies', async () => {
    const dollars = await createGroup(adaToken, 'Dollars', 'USD');
    expect(await merge(flat, dollars)).toMatchObject({ status: 409, body: { type: 'CurrencyMismatch' } });
    expect((await call(app, 'GET', `/groups/${dollars}`, { token: adaToken })).status).toBe(200);
  });

  it('is refused for a group the caller is not a member of, as for a group that does not exist', async () => {
    expect(await merge(flat, rent, outsiderToken)).toMatchObject({ status: 404, body: { type: 'NotFound' } });
    expect(await merge(flat, '00000000-0000-0000-0000-000000000000')).toMatchObject({ status: 404 });
  });

  it('is refused for an archived group, either of the two', async () => {
    const emptied = await createGroup(adaToken, 'Empty');
    expect((await call(app, 'POST', `/groups/${emptied}/archive`, { token: adaToken })).status).toBe(204);
    expect(await merge(flat, emptied)).toMatchObject({ status: 409, body: { type: 'GroupArchived' } });
    expect(await merge(emptied, rent)).toMatchObject({ status: 409, body: { type: 'GroupArchived' } });
    expect((await call(app, 'GET', `/groups/${rent}/balances`, { token: adaToken })).status).toBe(200);
  });

  it('is refused without the group to merge in the body', async () => {
    expect((await call(app, 'POST', `/groups/${flat}/merge`, { body: {}, token: adaToken })).status).toBe(400);
  });

  it('records an expense in the group merged at once, or is refused: each recorded expense is counted once in the group kept', async () => {
    await recordedIn(flat);
    const recording = Array.from({ length: 12 }, () =>
      record(rent, adaToken, { splitBetween: [adaId, graceId], amount: 500 }),
    );
    const [merged, ...answers] = await Promise.all([merge(flat, rent), ...recording]);
    expect(merged.status).toBe(204);
    const recorded = answers.filter(answer => answer.status === 201).map(answer => answer.body.id);
    for (const answer of answers) {
      if (answer.status !== 201) expect(answer).toMatchObject({ status: 404, body: { type: 'NotFound' } });
    }
    const listed = (await call(app, 'GET', `/groups/${flat}/expenses`, { token: adaToken })).body;
    expect(listed.length).toBe(1 + recorded.length);
    expect(listed.map((expense: { id: string }) => expense.id)).toEqual(expect.arrayContaining(recorded));
    expect(sumOf(asMap((await balances(flat)).body))).toBe(0);
  });

  describe('while a payment through the provider waits in the group merged', () => {
    beforeEach(async () => {
      provider = await startFakeProvider();
      await app.stop();
      app = await startApplication(database.url, { providerUrl: provider.url, providerWebhookSecret: SECRET });
      expect(
        (await call(app, 'PUT', '/accounts/me/payout-account', { body: { accountId: adaPayout }, token: adaToken }))
          .status,
      ).toBe(204);
    });

    afterEach(async () => {
      await provider.stop();
    });

    it('is refused until the payment is no longer waiting', async () => {
      await recordedIn(rent, { splitBetween: [adaId, graceId] });
      const asked = await call(app, 'POST', `/groups/${rent}/settlements/provider`, {
        body: { to: adaId, amount: 1000 },
        token: graceToken,
      });
      expect(asked.status).toBe(201);
      expect(await merge(flat, rent)).toMatchObject({ status: 409, body: { type: 'SettlementWaiting' } });
      expect((await call(app, 'GET', `/groups/${rent}/balances`, { token: adaToken })).status).toBe(200);
    });
  });
});
