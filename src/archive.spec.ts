import { createHmac } from 'node:crypto';
import { countRows } from './test-support';
import { Application } from './app';
import { ada, call, FakeProvider, startApplication, startFakeProvider, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const sam = { email: 'sam@example.com', password: 'sam-password-1', name: 'Sam' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };

const PAST_DAY = '2026-11-01';
const ARCHIVED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;
// The provider's id of Ada's payout account, and the secret its webhooks are signed with.
const adaPayout = 'acct_ada';
const SECRET = 'whsec_test';
const AT = '2026-11-20T10:00:00Z';

/** A day of the month `months` before this one, with the day of month `dom`. */
function monthsAgo(months: number, dom: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, dom)).toISOString().slice(0, 10);
}

/** How many rows a table of the database holds, read beside the application. */
const rowsIn = (url: string, table: string): Promise<number> => countRows(url, table);

/** Refused as a change to an archived group is: `409`, by the name of the one rule. */
function expectArchived(answer: { status: number; body: unknown }): void {
  expect(answer).toMatchObject({ status: 409, body: { type: 'GroupArchived' } });
}

describe('archiving a group', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let provider: FakeProvider;
  let app: Application;
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
    expect((await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken })).status).toBe(
      204,
    );
  }

  const archive = (token = adaToken) => call(app, 'POST', `/groups/${groupId}/archive`, { token });
  const group = (token = adaToken) => call(app, 'GET', `/groups/${groupId}`, { token });
  const askProvider = (body: unknown, token: string) =>
    call(app, 'POST', `/groups/${groupId}/settlements/provider`, { body, token });

  /** The webhook of the provider about a payment, signed as the provider signs it. */
  const decide = (paymentId: string, status: string) => {
    const raw = JSON.stringify({ id: `wh_${paymentId}_${status}`, paymentId, status, at: AT });
    const signature = createHmac('sha256', SECRET).update(raw).digest('hex');
    return call(app, 'POST', '/provider/webhooks', { raw, headers: { 'Provider-Signature': signature } });
  };

  /**
   * Ada paid 3000 for the three of them, split exactly: Ada is owed 2000, Grace and Linus each owe 1000. Answers
   * the expense's id.
   */
  async function dinner(): Promise<string> {
    const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
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
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  /** Grace and Linus each pay Ada their 1000 in cash, so every balance is 0. */
  async function settleInCash(): Promise<void> {
    for (const from of [graceId, linusId]) {
      const answer = await call(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        body: { from, amount: 1000 },
        token: adaToken,
      });
      expect(answer.status).toBe(201);
    }
  }

  /**
   * Grace and Linus each pay Ada 1000 through the provider, which says both succeeded: the payments are `pay_1` and
   * `pay_2`, in that order. Answers the two settlements' ids.
   */
  async function paidThroughProvider(): Promise<{ first: string; second: string }> {
    const first = await askProvider({ to: adaId, amount: 1000 }, graceToken);
    expect(first.status).toBe(201);
    expect((await decide('pay_1', 'succeeded')).status).toBe(204);
    const second = await askProvider({ to: adaId, amount: 1000 }, linusToken);
    expect(second.status).toBe(201);
    expect((await decide('pay_2', 'succeeded')).status).toBe(204);
    return { first: first.body.id, second: second.body.id };
  }

  /** The group as its members read it: everything but its own record, which an archive changes. */
  async function readsOf(token = adaToken) {
    const get = async (path: string) => (await call(app, 'GET', `/groups/${groupId}${path}`, { token })).body;
    return {
      members: await get('/members'),
      balances: await get('/balances'),
      expenses: await get('/expenses'),
      settlements: await get('/settlements'),
      suggested: await get('/settlements/suggested'),
      budgets: await get('/budgets'),
      templates: await get('/templates'),
      recurring: await get('/recurring'),
    };
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    provider = await startFakeProvider();
    app = await startApplication(database.url, { providerUrl: provider.url, providerWebhookSecret: SECRET });
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    // Ada is paid through the provider, on her payout account. Setting it asks the provider, which is not a payment.
    expect(
      (await call(app, 'PUT', '/accounts/me/payout-account', { body: { accountId: adaPayout }, token: adaToken }))
        .status,
    ).toBe(204);
    provider.requests.splice(0);
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
    await accountOf(sam);
    ({ token: outsiderToken } = await accountOf(outsiderAccount));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The trip', currency: 'EUR' }, token: adaToken }))
      .body.id;
    await join(graceToken);
    await join(linusToken);
  });

  afterEach(async () => {
    await app.stop();
    await provider.stop();
    await database.remove();
  });

  it('archives a group once every balance is 0, and reads it as archived from then on', async () => {
    await dinner();
    await settleInCash();
    expect((await group()).body).not.toHaveProperty('archivedAt');
    const before = await readsOf();

    expect((await archive()).status).toBe(204);

    const archived = (await group()).body.archivedAt;
    expect(archived).toMatch(ARCHIVED_AT);
    expect((await group(graceToken)).body).toMatchObject({ id: groupId, archivedAt: archived });
    const mine = (await call(app, 'GET', '/groups/mine', { token: graceToken })).body;
    expect(mine).toEqual([expect.objectContaining({ id: groupId, archivedAt: archived })]);
    // It stays among the groups, and its members read it as before.
    expect(await readsOf()).toEqual(before);
    expect(await readsOf(graceToken)).toEqual(before);
  });

  it('does not archive a group with a balance that is not 0, and changes nothing', async () => {
    await dinner();

    expect(await archive()).toMatchObject({ status: 409, body: { type: 'BalancesNotZero' } });
    expect((await group()).body).not.toHaveProperty('archivedAt');
  });

  it('refuses to archive a group for a member who is not its owner, and for an account that is not a member', async () => {
    await dinner();
    await settleInCash();

    expect(await archive(graceToken)).toMatchObject({ status: 403, body: { type: 'NotAllowed' } });
    expect(await archive(outsiderToken)).toMatchObject({ status: 404, body: { type: 'NotFound' } });
    expect((await group()).body).not.toHaveProperty('archivedAt');
  });

  it('refuses to archive it again, and changes nothing', async () => {
    await dinner();
    await settleInCash();
    expect((await archive()).status).toBe(204);
    const archivedAt = (await group()).body.archivedAt;

    expectArchived(await archive());
    expect((await group()).body.archivedAt).toBe(archivedAt);
  });

  it('refuses to archive while a refund through the provider is refunding, and archives once it is refunded', async () => {
    await dinner();
    const { first } = await paidThroughProvider();
    expect((await call(app, 'POST', `/settlements/${first}/refund`, { token: adaToken })).status).toBe(204);

    // Refunding is still counted as paid, so the balances are 0, and the refund is still waiting at the provider.
    expect(await archive()).toMatchObject({ status: 409, body: { type: 'SettlementWaiting' } });
    expect((await group()).body).not.toHaveProperty('archivedAt');
  });

  it('refuses to archive while a payment through the provider is pending, and changes nothing', async () => {
    await dinner();
    expect((await askProvider({ to: adaId, amount: 1000 }, graceToken)).status).toBe(201);

    expect(await archive()).toMatchObject({ status: 409 });
    expect((await group()).body).not.toHaveProperty('archivedAt');
  });

  it('archives a group whose payments through the provider are paid, and refuses to refund one of them', async () => {
    await dinner();
    const { first } = await paidThroughProvider();
    provider.requests.splice(0);

    expect((await archive()).status).toBe(204);

    expectArchived(await call(app, 'POST', `/settlements/${first}/refund`, { token: adaToken }));
    expect((await call(app, 'GET', `/settlements/${first}`, { token: graceToken })).body.status).toBe('paid');
    expect(provider.requests.filter(request => request.path.endsWith('/refunds'))).toEqual([]);
  });
});

describe('an archived group, read only', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let provider: FakeProvider;
  let app: Application;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;
  let samToken: string;
  let groupId: string;
  let expenseId: string;
  let invitationId: string;
  let recurringId: string;
  let templateId: string;

  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  async function join(accountToken: string): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    expect((await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken })).status).toBe(
      204,
    );
  }

  /** Attaches a receipt to the expense, as the bytes of a JPEG, and answers the status and the body. */
  async function attachReceipt(expense: string, token: string) {
    const response = await fetch(`${app.address}/${app.apiPrefix}/expenses/${expense}/receipt`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
      body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  }

  /** The group as its members read it, which no refused change may alter. */
  async function readsOf(token = adaToken) {
    const get = async (path: string) => (await call(app, 'GET', `/groups/${groupId}${path}`, { token })).body;
    return {
      members: await get('/members'),
      balances: await get('/balances'),
      expenses: await get('/expenses'),
      settlements: await get('/settlements'),
      budgets: await get('/budgets'),
      templates: await get('/templates'),
      recurring: await get('/recurring'),
    };
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    provider = await startFakeProvider();
    app = await startApplication(database.url, { providerUrl: provider.url, providerWebhookSecret: SECRET });
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
    ({ token: samToken } = await accountOf(sam));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The trip', currency: 'EUR' }, token: adaToken }))
      .body.id;
    await join(graceToken);
    await join(linusToken);

    // A group with an expense, a settlement, an invitation, a recurring expense, a budget and a template, all settled.
    expenseId = (
      await call(app, 'POST', `/groups/${groupId}/expenses`, {
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
      })
    ).body.id;
    for (const from of [graceId, linusId]) {
      expect(
        (
          await call(app, 'POST', `/groups/${groupId}/settlements/cash`, {
            body: { from, amount: 1000 },
            token: adaToken,
          })
        ).status,
      ).toBe(201);
    }
    invitationId = (await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken })).body.id;
    recurringId = (
      await call(app, 'POST', `/groups/${groupId}/recurring`, {
        body: { description: 'Rent', amount: 1000, startsOn: monthsAgo(1, 5), splitBetween: [adaId, graceId] },
        token: adaToken,
      })
    ).body.id;
    expect(
      (await call(app, 'PUT', `/groups/${groupId}/budgets/groceries`, { body: { amount: 5000 }, token: adaToken }))
        .status,
    ).toBe(204);
    templateId = (
      await call(app, 'POST', `/groups/${groupId}/templates`, {
        body: { name: 'Flat', splitBetween: [adaId, graceId] },
        token: adaToken,
      })
    ).body.id;

    expect((await call(app, 'POST', `/groups/${groupId}/archive`, { token: adaToken })).status).toBe(204);
  });

  afterEach(async () => {
    await app.stop();
    await provider.stop();
    await database.remove();
  });

  it('refuses recording an expense, and changes nothing', async () => {
    const before = await readsOf();
    const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: { description: 'Late', amount: 500, date: PAST_DAY, splitBetween: [adaId, graceId] },
      token: adaToken,
    });
    expectArchived(answer);
    expect(await readsOf()).toEqual(before);
  });

  it('refuses editing an expense from the version read, and changes nothing', async () => {
    const before = await readsOf();
    const answer = await call(app, 'PUT', `/expenses/${expenseId}`, {
      body: {
        description: 'Dinner, edited',
        amount: 3000,
        date: PAST_DAY,
        splitBetween: [adaId, graceId, linusId],
        version: 1,
      },
      token: adaToken,
    });
    expectArchived(answer);
    expect((await call(app, 'GET', `/expenses/${expenseId}`, { token: adaToken })).body).toMatchObject({
      description: 'Dinner',
      version: 1,
    });
    expect(await readsOf()).toEqual(before);
  });

  it('refuses deleting an expense, and changes nothing', async () => {
    const before = await readsOf();
    expectArchived(await call(app, 'DELETE', `/expenses/${expenseId}`, { token: adaToken }));
    expect(await readsOf()).toEqual(before);
  });

  it('refuses attaching a receipt to an expense, and keeps none', async () => {
    expectArchived(await attachReceipt(expenseId, adaToken));
    expect((await call(app, 'GET', `/expenses/${expenseId}/receipt`, { token: adaToken })).status).toBe(404);
  });

  it('refuses recording a settlement in cash, even one that would be refused for its amount, and changes nothing', async () => {
    const before = await readsOf();
    expectArchived(
      await call(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        body: { from: graceId, amount: 500 },
        token: adaToken,
      }),
    );
    expect(await readsOf()).toEqual(before);
  });

  it('refuses asking for a settlement through the provider, without asking the provider', async () => {
    const before = await readsOf();
    const asked = provider.requests.length;
    expectArchived(
      await call(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        body: { to: adaId, amount: 500 },
        token: graceToken,
      }),
    );
    expect(provider.requests.length).toBe(asked);
    expect(await readsOf()).toEqual(before);
  });

  it('refuses creating an invitation, and creates none', async () => {
    const before = await rowsIn(database.url, 'invitations');
    expectArchived(await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken }));
    expect(await rowsIn(database.url, 'invitations')).toBe(before);
  });

  it('refuses an account joining by an invitation made before the archive, and it is not a member', async () => {
    expectArchived(await call(app, 'POST', `/invitations/${invitationId}/accept`, { token: samToken }));
    expect((await call(app, 'GET', `/groups/${groupId}`, { token: samToken })).status).toBe(404);
    const members = (await readsOf()).members.map((member: { memberId: string }) => member.memberId);
    expect(members).toEqual([adaId, graceId, linusId]);
  });

  it('refuses a member leaving, who stays in the group with the balance 0', async () => {
    const before = await readsOf();
    expectArchived(await call(app, 'POST', `/groups/${groupId}/leave`, { token: graceToken }));
    expect(await readsOf()).toEqual(before);
    expect((await call(app, 'GET', `/groups/${groupId}`, { token: graceToken })).status).toBe(200);
  });

  it('refuses setting up a recurring expense, and changes nothing', async () => {
    const before = await readsOf();
    expectArchived(
      await call(app, 'POST', `/groups/${groupId}/recurring`, {
        body: { description: 'Gas', amount: 800, startsOn: monthsAgo(1, 9), splitBetween: [adaId] },
        token: adaToken,
      }),
    );
    expect(await readsOf()).toEqual(before);
  });

  it('refuses stopping a recurring expense, which stays set up', async () => {
    expectArchived(await call(app, 'DELETE', `/recurring/${recurringId}`, { token: adaToken }));
    expect((await call(app, 'GET', `/recurring/${recurringId}`, { token: adaToken })).status).toBe(200);
  });

  it('refuses setting a budget, to the owner as to any other member, and changes nothing', async () => {
    const before = await readsOf();
    expectArchived(
      await call(app, 'PUT', `/groups/${groupId}/budgets/food`, { body: { amount: 100 }, token: adaToken }),
    );
    expectArchived(
      await call(app, 'PUT', `/groups/${groupId}/budgets/food`, { body: { amount: 100 }, token: graceToken }),
    );
    expect(await readsOf()).toEqual(before);
  });

  it('refuses removing a budget, which stays', async () => {
    expectArchived(await call(app, 'DELETE', `/groups/${groupId}/budgets/groceries`, { token: adaToken }));
    expect((await call(app, 'GET', `/groups/${groupId}/budgets`, { token: adaToken })).body).toEqual([
      { category: 'groceries', amount: 5000, spent: 0 },
    ]);
  });

  it('refuses saving a template, and changes nothing', async () => {
    const before = await readsOf();
    expectArchived(
      await call(app, 'POST', `/groups/${groupId}/templates`, {
        body: { name: 'Trips', splitBetween: [adaId] },
        token: adaToken,
      }),
    );
    expect(await readsOf()).toEqual(before);
  });

  it('refuses replacing a template, and keeps it as it was', async () => {
    expectArchived(
      await call(app, 'PUT', `/templates/${templateId}`, {
        body: { name: 'Renamed', splitBetween: [adaId] },
        token: adaToken,
      }),
    );
    expect((await readsOf()).templates).toEqual([
      { id: templateId, groupId, name: 'Flat', splitBetween: [adaId, graceId] },
    ]);
  });

  it('refuses removing a template, which stays', async () => {
    expectArchived(await call(app, 'DELETE', `/templates/${templateId}`, { token: adaToken }));
    expect((await readsOf()).templates).toHaveLength(1);
  });

  it('keeps every read of its members as it was, with the group archived', async () => {
    for (const token of [adaToken, graceToken, linusToken]) {
      expect((await call(app, 'GET', `/groups/${groupId}`, { token })).body).toMatchObject({
        id: groupId,
        archivedAt: expect.stringMatching(ARCHIVED_AT),
      });
      expect((await call(app, 'GET', `/groups/${groupId}/members`, { token })).status).toBe(200);
      expect((await call(app, 'GET', `/groups/${groupId}/balances`, { token })).status).toBe(200);
      expect((await call(app, 'GET', `/groups/${groupId}/expenses`, { token })).status).toBe(200);
      expect((await call(app, 'GET', `/expenses/${expenseId}`, { token })).status).toBe(200);
      expect((await call(app, 'GET', `/expenses/${expenseId}/receipt`, { token })).status).toBe(404);
      expect((await call(app, 'GET', `/groups/${groupId}/settlements`, { token })).status).toBe(200);
      expect((await call(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token })).status).toBe(200);
      expect((await call(app, 'GET', `/groups/${groupId}/members/${graceId}/statement`, { token })).status).toBe(200);
      expect((await call(app, 'GET', `/groups/${groupId}/budgets`, { token })).status).toBe(200);
      expect((await call(app, 'GET', `/groups/${groupId}/templates`, { token })).status).toBe(200);
      expect((await call(app, 'GET', `/groups/${groupId}/recurring`, { token })).status).toBe(200);
      expect((await call(app, 'GET', `/recurring/${recurringId}`, { token })).status).toBe(200);
    }
  });
});

describe('the background job and an archived group', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let adaId: string;
  let adaToken: string;
  let archivedId: string;
  let openId: string;
  let archivedRecurring: string;
  let openRecurring: string;

  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  /** A group of Ada alone, with a recurring expense of hers that is due since last month. */
  async function groupWithRecurring(name: string): Promise<{ groupId: string; recurringId: string }> {
    const groupId = (await call(app, 'POST', '/groups', { body: { name, currency: 'EUR' }, token: adaToken })).body.id;
    const recurringId = (
      await call(app, 'POST', `/groups/${groupId}/recurring`, {
        body: { description: 'Rent', amount: 1000, startsOn: monthsAgo(1, 5), splitBetween: [adaId] },
        token: adaToken,
      })
    ).body.id;
    return { groupId, recurringId };
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    app = await startApplication(database.url);
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ groupId: archivedId, recurringId: archivedRecurring } = await groupWithRecurring('Archived'));
    ({ groupId: openId, recurringId: openRecurring } = await groupWithRecurring('Open'));
    expect((await call(app, 'POST', `/groups/${archivedId}/archive`, { token: adaToken })).status).toBe(204);
  });

  afterEach(async () => {
    await app.stop();
    await database.remove();
  });

  it('records no expense of a recurring expense in an archived group, and leaves its next day as it was', async () => {
    const before = (await call(app, 'GET', `/recurring/${archivedRecurring}`, { token: adaToken })).body;

    await app.runJobs();

    expect((await call(app, 'GET', `/groups/${archivedId}/expenses`, { token: adaToken })).body).toEqual([]);
    expect((await call(app, 'GET', `/recurring/${archivedRecurring}`, { token: adaToken })).body).toEqual(before);
  });

  it('still records the expenses of a recurring expense in a group that is not archived', async () => {
    await app.runJobs();

    const recorded = (await call(app, 'GET', `/groups/${openId}/expenses`, { token: adaToken })).body;
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((expense: { description: string }) => expense.description === 'Rent')).toBe(true);
    expect((await call(app, 'GET', `/recurring/${openRecurring}`, { token: adaToken })).body.next).not.toBe(
      monthsAgo(1, 5),
    );
  });

  it('keeps the archived group among the groups of its members', async () => {
    const mine = (await call(app, 'GET', '/groups/mine', { token: adaToken })).body;
    expect(mine).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: archivedId, archivedAt: expect.stringMatching(ARCHIVED_AT) }),
        expect.objectContaining({ id: openId }),
      ]),
    );
    expect(mine.find((group: { id: string }) => group.id === openId)).not.toHaveProperty('archivedAt');
  });
});
