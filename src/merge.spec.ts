import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Application, createApplication } from './app';
import { ensureDatabase, send, signedUpAccount, testDirectory, type Reply, type TestDirectory } from './test-helpers';

const SECRET = 'shared with the provider';

interface Member {
  id: string;
  token: string;
}

interface Listed {
  memberId: string;
  role: string;
  joinedAt: string;
}

/** Today's day in UTC, `YYYY-MM-DD`: the latest date an expense may have. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function answer(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function listening(server: Server): Promise<string> {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

function closed(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Answers `reply` when it is `status`; otherwise says what the setup got instead, so a failing setup reads plainly. */
function must(reply: Reply, status: number): Reply {
  if (reply.status !== status) throw new Error(`answered ${reply.status}: ${JSON.stringify(reply.body)}`);
  return reply;
}

/** The balances of a list, as a map from member to balance. */
function asMap(balances: unknown): Map<string, number> {
  return new Map((balances as { memberId: string; balance: number }[]).map(b => [b.memberId, b.balance]));
}

/**
 * The balances the group kept must show after the merge, member by member: what each showed in the group kept, plus what
 * it showed in the group merged (a member that did not show counts 0).
 */
function expectedAfterMerge(kept: Map<string, number>, merged: Map<string, number>): Map<string, number> {
  const expected = new Map<string, number>();
  for (const member of new Set([...kept.keys(), ...merged.keys()])) {
    expected.set(member, (kept.get(member) ?? 0) + (merged.get(member) ?? 0));
  }
  return expected;
}

describe('merging two groups', () => {
  let directory: TestDirectory;
  let app: Application;
  let providerServer: Server;
  let nextPayment: number;
  let ana: Member;
  let ben: Member;
  let cy: Member;
  let dee: Member;

  beforeEach(async () => {
    directory = testDirectory();
    nextPayment = 1;
    // The provider: it knows every account, and creates a payment `pay_N` for every payment asked of it.
    providerServer = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      request.on('end', () => {
        const path = request.url ?? '';
        if (path.startsWith('/accounts/')) {
          answer(response, 200, { id: decodeURIComponent(path.slice('/accounts/'.length)) });
        } else {
          const n = nextPayment++;
          answer(response, 201, { id: `pay_${n}`, payUrl: `https://pay.example.org/${n}` });
        }
      });
    });
    const providerUrl = await listening(providerServer);
    await ensureDatabase(directory.databaseUrl);
    app = await createApplication({
      databaseUrl: directory.databaseUrl,
      databasePath: '',
      providerUrl,
      providerWebhookSecret: SECRET,
    });
    await app.start(0);
    ana = await signedUpAccount(app, { email: 'ana@example.org', name: 'Ana' });
    ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    cy = await signedUpAccount(app, { email: 'cy@example.org', name: 'Cy' });
    dee = await signedUpAccount(app, { email: 'dee@example.org', name: 'Dee' });
  });

  afterEach(async () => {
    await app.stop();
    await closed(providerServer);
    await directory.remove();
  });

  /** Creates a group as `owner`, answering its id. */
  async function createGroup(owner: Member, currency = 'EUR', name = 'Flat'): Promise<string> {
    const reply = must(await send(app, 'POST', '/groups', { token: owner.token, body: { name, currency } }), 201);
    return (reply.body as { id: string }).id;
  }

  /** Makes `joiner` a member of the group, through an invitation the owner creates; answers the invitation's id. */
  async function join(owner: Member, groupId: string, joiner: Member): Promise<string> {
    const invitation = (
      must(await send(app, 'POST', `/groups/${groupId}/invitations`, { token: owner.token }), 201).body as {
        id: string;
      }
    ).id;
    must(await send(app, 'POST', `/invitations/${invitation}/accept`, { token: joiner.token }), 204);
    return invitation;
  }

  /** Records an expense in the group as `payer`, answering the reply. */
  async function record(payer: Member, groupId: string, body: Record<string, unknown>): Promise<Reply> {
    return send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: payer.token,
      body: { description: 'Dinner', amount: 1000, date: today(), ...body },
    });
  }

  /** Records an expense in the group as `payer`, which must succeed; answers its id. */
  async function recordOrFail(payer: Member, groupId: string, body: Record<string, unknown>): Promise<string> {
    return (must(await record(payer, groupId, body), 201).body as { id: string }).id;
  }

  /** The balances of the group, as `reader` reads them. */
  async function balancesOf(reader: Member, groupId: string): Promise<Map<string, number>> {
    return asMap(must(await send(app, 'GET', `/groups/${groupId}/balances`, { token: reader.token }), 200).body);
  }

  /** The current members of the group, as `reader` reads them, the earliest to join first. */
  async function membersOf(reader: Member, groupId: string): Promise<Listed[]> {
    return must(await send(app, 'GET', `/groups/${groupId}/members`, { token: reader.token }), 200).body as Listed[];
  }

  /** Merges the group `fromId` into `keptId` as `token`'s account. */
  async function merge(token: Member, keptId: string, fromId: string): Promise<Reply> {
    return send(app, 'POST', `/groups/${keptId}/merge`, { token: token.token, body: { from: fromId } });
  }

  /** Merges the group `fromId` into `keptId` as `token`'s account, which must succeed. */
  async function mergeOrFail(token: Member, keptId: string, fromId: string): Promise<void> {
    must(await merge(token, keptId, fromId), 204);
  }

  /** The balances of the group kept must be what {@link expectedAfterMerge} says, and add up to 0. */
  async function expectBalancesAdded(
    owner: Member,
    kept: string,
    before: { kept: Map<string, number>; merged: Map<string, number> },
  ): Promise<void> {
    const after = await balancesOf(owner, kept);
    expect(after).toEqual(expectedAfterMerge(before.kept, before.merged));
    expect([...after.values()].reduce((total, balance) => total + balance, 0)).toBe(0);
  }

  describe('answering the request', () => {
    it('answers 204 to the owner of both groups, and the group merged is gone for everyone', async () => {
      const kept = await createGroup(ana, 'EUR', 'Flat');
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      await join(ana, merged, ben);
      const invitation = (
        must(await send(app, 'POST', `/groups/${merged}/invitations`, { token: ana.token }), 201).body as { id: string }
      ).id;
      await recordOrFail(ben, merged, { amount: 900, splitBetween: [ana.id, ben.id] });

      await mergeOrFail(ana, kept, merged);

      expect((await send(app, 'GET', `/groups/${merged}`, { token: ana.token })).status).toBe(404);
      expect((await send(app, 'GET', `/groups/${merged}`, { token: ben.token })).status).toBe(404);
      expect((await send(app, 'GET', `/groups/${merged}/members`, { token: ben.token })).status).toBe(404);
      expect((await send(app, 'GET', `/groups/${merged}/balances`, { token: ana.token })).status).toBe(404);
      expect((await send(app, 'GET', `/groups/${kept}`, { token: ana.token })).status).toBe(200);

      const mine = must(await send(app, 'GET', '/groups/mine', { token: ana.token }), 200).body as { id: string }[];
      expect(mine.map(group => group.id)).toEqual([kept]);
      const benMine = must(await send(app, 'GET', '/groups/mine', { token: ben.token }), 200).body as { id: string }[];
      expect(benMine.map(group => group.id)).toEqual([kept]);

      // Its invitation no longer lets anyone join, and no more expenses are recorded in it.
      expect((await send(app, 'GET', `/invitations/${invitation}`, { token: cy.token })).status).toBe(404);
      const joined = await send(app, 'POST', `/invitations/${invitation}/accept`, { token: cy.token });
      expect(joined.status).toBe(404);
      const expense = await record(ben, merged, { splitBetween: [ana.id, ben.id] });
      expect(expense.status).toBe(404);
      expect((expense.body as { error: string }).error).toBe('GroupNotFound');
    });

    it('answers 404 for a group merged that is not a group of the caller', async () => {
      const kept = await createGroup(ana);
      const reply = await merge(ana, kept, randomUUID());
      expect(reply.status).toBe(404);
      expect((reply.body as { error: string }).error).toBe('GroupNotFound');
    });

    it('answers 400 when the group merged is not named', async () => {
      const kept = await createGroup(ana);
      const reply = await send(app, 'POST', `/groups/${kept}/merge`, { token: ana.token, body: {} });
      expect(reply.status).toBe(400);
    });
  });

  describe('refusals', () => {
    it('refuses, and changes nothing, when the caller does not own the group merged', async () => {
      const kept = await createGroup(ana);
      const merged = await createGroup(ben, 'EUR', 'Groceries');
      await join(ben, merged, ana);
      await recordOrFail(ben, merged, { amount: 900, splitBetween: [ana.id, ben.id] });
      const before = await balancesOf(ben, merged);

      const reply = await merge(ana, kept, merged);
      expect(reply.status).toBe(403);
      expect((reply.body as { error: string }).error).toBe('NotOwner');
      expect(await balancesOf(ben, merged)).toEqual(before);
      expect((await send(app, 'GET', `/groups/${merged}`, { token: ben.token })).status).toBe(200);
    });

    it('refuses as not found a group merged that the caller is no member of', async () => {
      const kept = await createGroup(ana);
      const merged = await createGroup(ben, 'EUR', 'Groceries');
      const reply = await merge(ana, kept, merged);
      expect(reply.status).toBe(404);
      expect((reply.body as { error: string }).error).toBe('GroupNotFound');
    });

    it('refuses as not found when the caller is not a member of the group kept', async () => {
      const kept = await createGroup(ben);
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      const reply = await merge(ana, kept, merged);
      expect(reply.status).toBe(404);
      expect((reply.body as { error: string }).error).toBe('GroupNotFound');
      expect((await send(app, 'GET', `/groups/${merged}`, { token: ana.token })).status).toBe(200);
    });

    it('refuses a group merged into itself', async () => {
      const kept = await createGroup(ana);
      const reply = await merge(ana, kept, kept);
      expect(reply.status).toBe(422);
      expect((reply.body as { error: string }).error).toBe('GroupsAreTheSame');
    });

    it('refuses groups in different currencies, and changes nothing', async () => {
      const kept = await createGroup(ana, 'EUR');
      const merged = await createGroup(ana, 'USD', 'Trip');
      await recordOrFail(ana, merged, { amount: 900, splitBetween: [ana.id] });
      const reply = await merge(ana, kept, merged);
      expect(reply.status).toBe(422);
      expect((reply.body as { error: string }).error).toBe('CurrenciesDiffer');
      expect((await send(app, 'GET', `/groups/${merged}`, { token: ana.token })).status).toBe(200);
    });

    it('refuses when the group merged is archived', async () => {
      const kept = await createGroup(ana);
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      must(await send(app, 'POST', `/groups/${merged}/archive`, { token: ana.token }), 204);
      const reply = await merge(ana, kept, merged);
      expect(reply.status).toBe(409);
      expect((reply.body as { error: string }).error).toBe('GroupIsArchived');
      expect((await send(app, 'GET', `/groups/${merged}`, { token: ana.token })).status).toBe(200);
    });

    it('refuses when the group kept is archived', async () => {
      const kept = await createGroup(ana);
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      must(await send(app, 'POST', `/groups/${kept}/archive`, { token: ana.token }), 204);
      const reply = await merge(ana, kept, merged);
      expect(reply.status).toBe(409);
      expect((reply.body as { error: string }).error).toBe('GroupIsArchived');
    });

    it('refuses while a settlement through the provider in the group merged is pending, and merges once it is paid', async () => {
      const kept = await createGroup(ana);
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      await join(ana, merged, ben);
      await recordOrFail(ana, merged, { amount: 1000, splitBetween: [ana.id, ben.id] });
      must(
        await send(app, 'PUT', '/accounts/me/payout-account', { token: ana.token, body: { accountId: 'acct_ana' } }),
        204,
      );
      must(
        await send(app, 'POST', `/groups/${merged}/settlements/provider`, {
          token: ben.token,
          body: { to: ana.id, amount: 500 },
        }),
        201,
      );
      const pending = await merge(ana, kept, merged);
      expect(pending.status).toBe(409);
      expect((pending.body as { error: string }).error).toBe('SettlementIsInProgress');
      expect((await send(app, 'GET', `/groups/${merged}`, { token: ana.token })).status).toBe(200);

      // The provider says the payment succeeded: the settlement counts, and the merge goes through.
      const body = JSON.stringify({ paymentId: 'pay_1', status: 'succeeded' });
      const webhook = await fetch(`${app.address}/${app.apiPrefix}/provider/webhooks`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'provider-signature': createHmac('sha256', SECRET).update(body).digest('hex'),
        },
        body,
      });
      expect(webhook.status).toBe(204);
      await mergeOrFail(ana, kept, merged);
      expect(await balancesOf(ana, kept)).toEqual(
        new Map([
          [ana.id, 0],
          [ben.id, 0],
        ]),
      );
    });
  });

  describe('the members', () => {
    it('joins the group kept after its members, in the order they joined the group merged, and a member of both stays where it is', async () => {
      const kept = await createGroup(ana);
      await join(ana, kept, ben);
      const keptBefore = await membersOf(ana, kept);
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      await join(ana, merged, dee);
      await join(ana, merged, cy);
      await join(ana, merged, ben);

      await mergeOrFail(ana, kept, merged);

      const after = await membersOf(ana, kept);
      expect(after.map(member => member.memberId)).toEqual([ana.id, ben.id, dee.id, cy.id]);
      expect(after.map(member => member.role)).toEqual(['owner', 'member', 'member', 'member']);
      expect(after[1]).toEqual(keptBefore[1]);
      expect(after[2].joinedAt >= keptBefore[1].joinedAt).toBe(true);
      expect(after[3].joinedAt >= after[2].joinedAt).toBe(true);
    });

    it('makes a former member of the group merged a former member of the group kept, whose statement is read there', async () => {
      const kept = await createGroup(ana);
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      await join(ana, merged, dee);
      must(await send(app, 'POST', `/groups/${merged}/leave`, { token: dee.token }), 204);

      await mergeOrFail(ana, kept, merged);

      expect((await membersOf(ana, kept)).map(member => member.memberId)).toEqual([ana.id]);
      const statement = await send(app, 'GET', `/groups/${kept}/members/${dee.id}/statement`, { token: ana.token });
      expect(statement.status).toBe(200);
      expect((statement.body as { memberId: string }).memberId).toBe(dee.id);
    });
  });

  describe('what moves', () => {
    it('moves the expenses with their id, payer, shares, version and category, read in the order of the group kept', async () => {
      const kept = await createGroup(ana);
      await join(ana, kept, ben);
      const before = await recordOrFail(ana, kept, {
        description: 'Kept',
        amount: 400,
        splitBetween: [ana.id, ben.id],
      });
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      await join(ana, merged, ben);
      const first = await recordOrFail(ana, merged, {
        description: 'Bread',
        amount: 1000,
        splitBetween: [ana.id, ben.id],
        category: 'groceries',
      });
      const edited = must(
        await send(app, 'PUT', `/expenses/${first}`, {
          token: ana.token,
          body: {
            description: 'Bread and milk',
            amount: 1000,
            date: today(),
            splitBetween: [ana.id, ben.id],
            category: 'groceries',
            version: 1,
          },
        }),
        200,
      );
      expect((edited.body as { version: number }).version).toBe(2);
      const second = await recordOrFail(ben, merged, {
        description: 'Taxi',
        amount: 600,
        splitExactly: [
          { memberId: ana.id, amount: 100 },
          { memberId: ben.id, amount: 500 },
        ],
        category: 'transport',
      });

      await mergeOrFail(ana, kept, merged);

      const listed = must(await send(app, 'GET', `/groups/${kept}/expenses`, { token: ana.token }), 200).body as Record<
        string,
        unknown
      >[];
      expect(listed.map(expense => expense.id)).toEqual([second, first, before]);
      const bread = listed[1];
      expect(bread).toMatchObject({
        id: first,
        groupId: kept,
        description: 'Bread and milk',
        amount: 1000,
        paidBy: ana.id,
        version: 2,
        splitKind: 'equal',
        category: 'groceries',
      });
      expect(bread.shares).toEqual([
        { memberId: ana.id, amount: 500 },
        { memberId: ben.id, amount: 500 },
      ]);
      expect(listed[0]).toMatchObject({ id: second, paidBy: ben.id, splitKind: 'exact', category: 'transport' });
      const single = must(await send(app, 'GET', `/expenses/${second}`, { token: ben.token }), 200).body as {
        groupId: string;
      };
      expect(single.groupId).toBe(kept);
    });

    it('moves the settlements of the group merged, with their status, read in the group kept', async () => {
      const kept = await createGroup(ana);
      await join(ana, kept, ben);
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      await join(ana, merged, ben);
      await recordOrFail(ana, merged, { amount: 1000, splitBetween: [ana.id, ben.id] });
      const settlement = (
        must(
          await send(app, 'POST', `/groups/${merged}/settlements/cash`, {
            token: ana.token,
            body: { from: ben.id, amount: 300 },
          }),
          201,
        ).body as { id: string }
      ).id;

      await mergeOrFail(ana, kept, merged);

      const listed = must(await send(app, 'GET', `/groups/${kept}/settlements`, { token: ben.token }), 200).body as {
        id: string;
        groupId: string;
        status: string;
      }[];
      expect(listed).toEqual([expect.objectContaining({ id: settlement, groupId: kept, status: 'paid' })]);
      expect(await balancesOf(ana, kept)).toEqual(
        new Map([
          [ana.id, 200],
          [ben.id, -200],
        ]),
      );
    });

    it('moves the recurring expenses of the group merged, read in the group kept', async () => {
      const kept = await createGroup(ana);
      await join(ana, kept, ben);
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      await join(ana, merged, ben);
      const recurring = (
        must(
          await send(app, 'POST', `/groups/${merged}/recurring`, {
            token: ana.token,
            body: { description: 'Milk', amount: 300, startsOn: '2026-12-05', splitBetween: [ana.id, ben.id] },
          }),
          201,
        ).body as { id: string }
      ).id;

      await mergeOrFail(ana, kept, merged);

      const listed = must(await send(app, 'GET', `/groups/${kept}/recurring`, { token: ana.token }), 200).body as {
        id: string;
        groupId: string;
      }[];
      expect(listed.map(item => [item.id, item.groupId])).toEqual([[recurring, kept]]);
      const single = must(await send(app, 'GET', `/recurring/${recurring}`, { token: ben.token }), 200).body as {
        groupId: string;
      };
      expect(single.groupId).toBe(kept);
    });

    it('moves the audit entries of the group merged, which the group kept reads and the group merged no longer has', async () => {
      const kept = await createGroup(ana);
      const keptExpense = await recordOrFail(ana, kept, { amount: 400, splitBetween: [ana.id] });
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      await join(ana, merged, ben);
      const mergedExpense = await recordOrFail(ben, merged, { amount: 600, splitBetween: [ana.id, ben.id] });

      await mergeOrFail(ana, kept, merged);

      const audit = must(await send(app, 'GET', `/groups/${kept}/audit`, { token: ana.token }), 200).body as {
        subjectId: string;
        action: string;
      }[];
      expect(audit.map(entry => [entry.action, entry.subjectId])).toEqual([
        ['expense-recorded', keptExpense],
        ['expense-recorded', mergedExpense],
      ]);
      expect((await send(app, 'GET', `/groups/${merged}/audit`, { token: ana.token })).status).toBe(404);
    });

    it('keeps the budgets, templates and invitations of the group kept, and drops those of the group merged', async () => {
      const kept = await createGroup(ana);
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      must(
        await send(app, 'PUT', `/groups/${kept}/budgets/groceries`, { token: ana.token, body: { amount: 5000 } }),
        204,
      );
      must(
        await send(app, 'PUT', `/groups/${merged}/budgets/groceries`, { token: ana.token, body: { amount: 9000 } }),
        204,
      );
      must(
        await send(app, 'PUT', `/groups/${merged}/budgets/rent`, { token: ana.token, body: { amount: 70000 } }),
        204,
      );
      must(
        await send(app, 'POST', `/groups/${merged}/templates`, {
          token: ana.token,
          body: { name: 'Even', splitBetween: [ana.id] },
        }),
        201,
      );
      const keptTemplate = must(
        await send(app, 'POST', `/groups/${kept}/templates`, {
          token: ana.token,
          body: { name: 'Mine', splitBetween: [ana.id] },
        }),
        201,
      ).body as { id: string };
      const invitation = (
        must(await send(app, 'POST', `/groups/${merged}/invitations`, { token: ana.token }), 201).body as { id: string }
      ).id;

      await mergeOrFail(ana, kept, merged);

      const budgets = must(await send(app, 'GET', `/groups/${kept}/budgets`, { token: ana.token }), 200).body as {
        category: string;
        amount: number;
      }[];
      expect(budgets.map(budget => [budget.category, budget.amount])).toEqual([['groceries', 5000]]);
      const templates = must(await send(app, 'GET', `/groups/${kept}/templates`, { token: ana.token }), 200).body as {
        id: string;
        name: string;
      }[];
      expect(templates.map(template => [template.id, template.name])).toEqual([[keptTemplate.id, 'Mine']]);
      expect((await send(app, 'GET', `/invitations/${invitation}`, { token: ben.token })).status).toBe(404);
    });

    it('keeps the notices as they were made, and they name the group merged', async () => {
      const kept = await createGroup(ana);
      await join(ana, kept, ben);
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      await join(ana, merged, ben);
      const expense = await recordOrFail(ana, merged, { amount: 1000, splitBetween: [ana.id, ben.id] });

      await mergeOrFail(ana, kept, merged);

      const notices = must(await send(app, 'GET', '/notices', { token: ben.token }), 200).body as {
        kind: string;
        groupId: string;
        expenseId?: string;
        amount: number;
      }[];
      expect(notices).toEqual([
        expect.objectContaining({ kind: 'expense', groupId: merged, expenseId: expense, amount: 500 }),
      ]);
    });
  });

  describe('the balances', () => {
    it('makes each balance in the group kept what it was there plus what it was in the group merged, and they add up to 0', async () => {
      const kept = await createGroup(ana);
      await join(ana, kept, ben);
      await recordOrFail(ana, kept, { amount: 1000, splitBetween: [ana.id, ben.id] });
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      await join(ana, merged, ben);
      await join(ana, merged, cy);
      await recordOrFail(ana, merged, { amount: 900, splitBetween: [ana.id, ben.id, cy.id] });
      must(
        await send(app, 'POST', `/groups/${merged}/settlements/cash`, {
          token: ana.token,
          body: { from: cy.id, amount: 100 },
        }),
        201,
      );
      const before = { kept: await balancesOf(ana, kept), merged: await balancesOf(ana, merged) };

      await mergeOrFail(ana, kept, merged);

      await expectBalancesAdded(ana, kept, before);
      expect(await balancesOf(ben, kept)).toEqual(
        new Map([
          [ana.id, 1000],
          [ben.id, -800],
          [cy.id, -200],
        ]),
      );
    });

    it('keeps what a former member of the group merged passed on to its owner', async () => {
      const kept = await createGroup(ana);
      await join(ana, kept, ben);
      await recordOrFail(ben, kept, { amount: 400, splitBetween: [ana.id, ben.id] });
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      await join(ana, merged, ben);
      await join(ana, merged, dee);
      await recordOrFail(ana, merged, { amount: 600, splitBetween: [ana.id, dee.id] });
      await recordOrFail(ana, merged, { amount: 1000, splitBetween: [ana.id, ben.id] });
      // Dee owes 300 and leaves: the 300 passes to the owner, Ana, who holds it in the group merged.
      must(await send(app, 'POST', `/groups/${merged}/leave`, { token: dee.token }), 204);
      const before = { kept: await balancesOf(ana, kept), merged: await balancesOf(ana, merged) };
      expect(before.merged.get(ana.id)).toBe(500);

      await mergeOrFail(ana, kept, merged);

      await expectBalancesAdded(ana, kept, before);
      expect(await balancesOf(ana, kept)).toEqual(
        new Map([
          [ana.id, 300],
          [ben.id, -300],
        ]),
      );
    });

    it('keeps the balance of a member of both who left the group merged, and sends what it passed on to the owner', async () => {
      const kept = await createGroup(ana);
      await join(ana, kept, ben);
      await recordOrFail(ana, kept, { amount: 400, splitBetween: [ana.id, ben.id] });
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      await join(ana, merged, ben);
      await recordOrFail(ben, merged, { amount: 600, splitBetween: [ben.id, ana.id] });
      must(await send(app, 'POST', `/groups/${merged}/leave`, { token: ben.token }), 204);
      const before = { kept: await balancesOf(ana, kept), merged: await balancesOf(ana, merged) };
      const benInKept = before.kept.get(ben.id);

      await mergeOrFail(ana, kept, merged);

      await expectBalancesAdded(ana, kept, before);
      // Ben is a member of both, so stays where he is; what he passed on in the group merged is Ana's.
      expect((await membersOf(ana, kept)).map(member => member.memberId)).toEqual([ana.id, ben.id]);
      expect((await balancesOf(ana, kept)).get(ben.id)).toBe(benInKept);
      // Ana's balance is what it was there, 200; the 300 Ben passed on in the group merged is in its balance, as its own.
      expect((await balancesOf(ana, kept)).get(ana.id)).toBe(200);
    });

    it('joins afresh a former member of the group kept who is a member of the group merged, and what it passed on stays with the owner', async () => {
      const kept = await createGroup(ana);
      await join(ana, kept, dee);
      await recordOrFail(ana, kept, { amount: 400, splitBetween: [ana.id, dee.id] });
      must(await send(app, 'POST', `/groups/${kept}/leave`, { token: dee.token }), 204);
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      await join(ana, merged, dee);
      await recordOrFail(dee, merged, { amount: 300, splitBetween: [dee.id, ana.id] });
      const before = { kept: await balancesOf(ana, kept), merged: await balancesOf(ana, merged) };
      expect(before.kept).toEqual(new Map([[ana.id, 0]]));

      await mergeOrFail(ana, kept, merged);

      await expectBalancesAdded(ana, kept, before);
      expect(await balancesOf(dee, kept)).toEqual(
        new Map([
          [ana.id, -150],
          [dee.id, 150],
        ]),
      );
      expect((await membersOf(ana, kept)).map(member => member.memberId)).toEqual([ana.id, dee.id]);
    });

    it('keeps a former member of both groups a former member, with what it passed on', async () => {
      const kept = await createGroup(ana);
      await join(ana, kept, dee);
      await recordOrFail(ana, kept, { amount: 400, splitBetween: [ana.id, dee.id] });
      must(await send(app, 'POST', `/groups/${kept}/leave`, { token: dee.token }), 204);
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      await join(ana, merged, dee);
      await recordOrFail(ana, merged, { amount: 600, splitBetween: [ana.id, dee.id] });
      must(await send(app, 'POST', `/groups/${merged}/leave`, { token: dee.token }), 204);
      const before = { kept: await balancesOf(ana, kept), merged: await balancesOf(ana, merged) };

      await mergeOrFail(ana, kept, merged);

      await expectBalancesAdded(ana, kept, before);
      expect((await membersOf(ana, kept)).map(member => member.memberId)).toEqual([ana.id]);
      expect((await send(app, 'GET', `/groups/${kept}/members/${dee.id}/statement`, { token: ana.token })).status).toBe(
        200,
      );
    });
  });

  describe('at the same moment', () => {
    it('counts an expense recorded in the group merged at the moment of the merge once, or refuses it', async () => {
      const kept = await createGroup(ana);
      await join(ana, kept, ben);
      const merged = await createGroup(ana, 'EUR', 'Groceries');
      await join(ana, merged, ben);

      const [merging, recorded] = await Promise.all([
        merge(ana, kept, merged),
        record(ben, merged, { amount: 700, splitBetween: [ana.id, ben.id] }),
      ]);
      expect(merging.status).toBe(204);

      const listed = must(await send(app, 'GET', `/groups/${kept}/expenses`, { token: ana.token }), 200).body as {
        id: string;
      }[];
      const balances = await balancesOf(ana, kept);
      if (recorded.status === 201) {
        const id = (recorded.body as { id: string }).id;
        expect(listed.filter(expense => expense.id === id)).toHaveLength(1);
        expect(balances).toEqual(
          new Map([
            [ana.id, 350],
            [ben.id, -350],
          ]),
        );
      } else {
        expect(recorded.status).toBe(404);
        expect(listed).toHaveLength(0);
        expect(balances).toEqual(
          new Map([
            [ana.id, 0],
            [ben.id, 0],
          ]),
        );
      }
    });
  });
});
