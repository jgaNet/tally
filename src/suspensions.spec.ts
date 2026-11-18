import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { type Application, createApplication } from './app';
import { type TestDirectory, ensureDatabase, send, signedUpAccount, testDirectory } from './test-helpers';

const START = Date.parse('2026-11-10T09:00:00.000Z');
const DAY = '2026-11-10';
const ADMIN_EMAILS = 'Admin@Example.org';

describe('suspending an account', () => {
  let directory: TestDirectory;
  let app: Application;
  let provider: Server;
  let providerUrl: string;
  let now: number;

  /**
   * A fake provider: it knows every account, and answers a payment with the id `pay_<reference>`, the reference being the
   * settlement's id.
   */
  beforeEach(async () => {
    now = START;
    directory = testDirectory();
    provider = createServer((request, response) => {
      let raw = '';
      request.on('data', chunk => (raw += chunk));
      request.on('end', () => {
        const path = request.url ?? '';
        const body = raw === '' ? {} : (JSON.parse(raw) as { reference?: string });
        if (path.startsWith('/accounts/')) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ id: decodeURIComponent(path.slice('/accounts/'.length)) }));
        } else if (path === '/payments') {
          response.writeHead(201, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              id: `pay_${body.reference}`,
              payUrl: `https://pay.example.org/${body.reference}`,
              fee: 0,
            }),
          );
        } else {
          response.writeHead(404);
          response.end();
        }
      });
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    await ensureDatabase(directory.databaseUrl);
    app = await createApplication({
      databaseUrl: directory.databaseUrl,
      providerUrl,
      providerWebhookSecret: 'shared with the provider',
      providerTimeoutMs: 200,
      adminEmails: ADMIN_EMAILS,
      clock: () => new Date(now),
    });
    await app.start(0);
  });

  afterEach(async () => {
    await app.stop();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    provider.closeAllConnections();
    await directory.remove();
  });

  /** The administrator account, which signs up in lowercase while ADMIN_EMAILS names it in mixed case. */
  async function administrator() {
    return signedUpAccount(app, { email: 'admin@example.org', name: 'Admin' });
  }

  /**
   * Ann, Ben and Cy in a group owned by Ann. Ann paid 3000 split equally between the three, so Ben and Cy each owe Ann
   * 1000. Ben and Cy have joined through invitations Ann's group makes.
   */
  async function threeInAGroup() {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const cy = await signedUpAccount(app, { email: 'cy@example.org', name: 'Cy' });
    const created = await send(app, 'POST', '/groups', { token: ann.token, body: { name: 'Flat', currency: 'EUR' } });
    const groupId = (created.body as { id: string }).id;
    for (const joiner of [ben, cy]) {
      const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ann.token });
      const accepted = await send(app, 'POST', `/invitations/${(invitation.body as { id: string }).id}/accept`, {
        token: joiner.token,
      });
      if (accepted.status !== 204) throw new Error(`accept answered ${accepted.status}`);
    }
    const expense = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Dinner', amount: 3000, date: DAY, splitBetween: [ann.id, ben.id, cy.id] },
    });
    if (expense.status !== 201) throw new Error(`record answered ${expense.status}`);
    return { ann, ben, cy, groupId };
  }

  /** Suspends the account `id`, as the administrator `admin`, and expects it done. */
  async function suspend(admin: { token: string }, id: string): Promise<void> {
    const reply = await send(app, 'PUT', `/admin/accounts/${id}/suspension`, { token: admin.token });
    if (reply.status !== 204) throw new Error(`suspend answered ${reply.status}`);
  }

  /** Reinstates the account `id`, as the administrator `admin`, and expects it done. */
  async function reinstate(admin: { token: string }, id: string): Promise<void> {
    const reply = await send(app, 'DELETE', `/admin/accounts/${id}/suspension`, { token: admin.token });
    if (reply.status !== 204) throw new Error(`reinstate answered ${reply.status}`);
  }

  /** What a member of the group reads of it: its members, balances, expenses, settlements, audit and recurring expenses. */
  async function readingOf(token: string, groupId: string) {
    const read = async (path: string) => {
      const reply = await send(app, 'GET', `/groups/${groupId}${path}`, { token });
      if (reply.status !== 200) throw new Error(`${path} answered ${reply.status}`);
      return reply.body;
    };
    return {
      members: await read('/members'),
      balances: await read('/balances'),
      expenses: await read('/expenses'),
      settlements: await read('/settlements'),
      audit: await read('/audit'),
      recurring: await read('/recurring'),
    };
  }

  it('is made and ended by an administrator alone: anyone else is refused, and one not signed in is answered 401', async () => {
    const { ben } = await threeInAGroup();
    const admin = await administrator();
    expect((await send(app, 'PUT', `/admin/accounts/${ben.id}/suspension`, { token: ben.token })).body).toMatchObject({
      error: 'NotAnAdministrator',
    });
    expect((await send(app, 'PUT', `/admin/accounts/${ben.id}/suspension`, { token: ben.token })).status).toBe(403);
    expect((await send(app, 'PUT', `/admin/accounts/${ben.id}/suspension`)).status).toBe(401);
    expect((await send(app, 'DELETE', `/admin/accounts/${ben.id}/suspension`, { token: ben.token })).status).toBe(403);
    expect((await send(app, 'DELETE', `/admin/accounts/${ben.id}/suspension`)).status).toBe(401);
    expect(
      (await send(app, 'PUT', '/admin/accounts/no-such-account/suspension', { token: admin.token })).body,
    ).toMatchObject({ error: 'AccountNotFound' });
    expect((await send(app, 'GET', '/admin/log', { token: admin.token })).body).toEqual([]);
  });

  it('refuses a suspended account the five changes, each by the one rule, and changes nothing in any group', async () => {
    const { ann, ben, groupId } = await threeInAGroup();
    const admin = await administrator();
    await suspend(admin, ben.id);
    const before = await readingOf(ann.token, groupId);

    const refusals = [
      send(app, 'POST', `/groups/${groupId}/expenses`, {
        token: ben.token,
        body: { description: 'Taxi', amount: 500, date: DAY, splitBetween: [ann.id, ben.id] },
      }),
      send(app, 'POST', `/groups/${groupId}/recurring`, {
        token: ben.token,
        body: { description: 'Rent', amount: 1001, startsOn: DAY, splitBetween: [ann.id, ben.id] },
      }),
      // A cash settlement is recorded by its payee, here Ben.
      send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
        token: ben.token,
        body: { from: ann.id, amount: 100 },
      }),
      // A payment through the provider is asked by its payer, here Ben.
      send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
        token: ben.token,
        body: { to: ann.id, amount: 1000 },
      }),
      send(app, 'POST', '/nettings', { token: ben.token, body: { with: ann.id, currency: 'EUR' } }),
    ];
    for (const reply of await Promise.all(refusals)) {
      expect(reply.status).toBe(403);
      expect(reply.body).toMatchObject({ error: 'AccountIsSuspended' });
    }
    expect(await readingOf(ann.token, groupId)).toEqual(before);
    const log = (await send(app, 'GET', '/admin/log', { token: admin.token })).body as { action: string }[];
    expect(log.map(entry => entry.action)).toEqual(['suspended']);
  });

  it('lets a suspended account sign in, read, edit and delete an expense, and leave its group', async () => {
    const { ann, ben, cy, groupId } = await threeInAGroup();
    const admin = await administrator();
    const recorded = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ben.token,
      body: { description: 'Groceries', amount: 900, date: DAY, splitBetween: [ann.id, ben.id, cy.id] },
    });
    const expenseId = (recorded.body as { id: string }).id;
    await suspend(admin, ben.id);

    const signedIn = await send(app, 'POST', '/accounts/login', {
      body: { email: 'ben@example.org', password: 'correct horse' },
    });
    expect(signedIn.status).toBe(200);
    const token = (signedIn.body as { token: string }).token;
    expect((await send(app, 'GET', `/groups/${groupId}`, { token })).status).toBe(200);
    expect((await send(app, 'GET', `/groups/${groupId}/balances`, { token })).status).toBe(200);
    expect((await send(app, 'GET', `/expenses/${expenseId}`, { token })).status).toBe(200);

    const edited = await send(app, 'PUT', `/expenses/${expenseId}`, {
      token,
      body: { description: 'Groceries', amount: 600, date: DAY, splitBetween: [ann.id, ben.id, cy.id], version: 1 },
    });
    expect(edited.status).toBe(200);
    expect((await send(app, 'DELETE', `/expenses/${expenseId}`, { token })).status).toBe(204);

    // Ben owes Ann 1000 still, which Ann records as paid in cash: Ben's balance is then 0, and Ben may leave.
    const paid = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: ben.id, amount: 1000 },
    });
    expect(paid.status).toBe(201);
    expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token })).status).toBe(204);
  });

  it('lets its group go on as before: a member puts it in a split, records its payment in cash, and pays it through the provider', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const cy = await signedUpAccount(app, { email: 'cy@example.org', name: 'Cy' });
    const created = await send(app, 'POST', '/groups', { token: ann.token, body: { name: 'Flat', currency: 'EUR' } });
    const groupId = (created.body as { id: string }).id;
    for (const joiner of [ben, cy]) {
      const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ann.token });
      await send(app, 'POST', `/invitations/${(invitation.body as { id: string }).id}/accept`, { token: joiner.token });
    }
    // Ben paid 600 for Ben and Cy: Cy owes Ben 300. Then Ann's hotel, split between Ann and Ben, leaves Ben owed 150 in all,
    // so Cy pays Ben 150. Ben has a payout account, which a payment through the provider needs.
    await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ben.token,
      body: { description: 'Tickets', amount: 600, date: DAY, splitBetween: [ben.id, cy.id] },
    });
    expect(
      (
        await send(app, 'PUT', '/accounts/me/payout-account', {
          token: ben.token,
          body: { accountId: `acct_${ben.id}` },
        })
      ).status,
    ).toBe(204);
    const admin = await administrator();
    await suspend(admin, ben.id);

    const split = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Hotel', amount: 300, date: DAY, splitBetween: [ann.id, ben.id] },
    });
    expect(split.status).toBe(201);
    const provider = await send(app, 'POST', `/groups/${groupId}/settlements/provider`, {
      token: cy.token,
      body: { to: ben.id, amount: 150 },
    });
    expect(provider.status).toBe(201);
    const settlements = (await send(app, 'GET', `/groups/${groupId}/settlements`, { token: cy.token })).body as {
      id: string;
      status: string;
    }[];
    expect(settlements).toEqual([
      expect.objectContaining({ id: (provider.body as { id: string }).id, status: 'pending' }),
    ]);
  });

  it('holds the background job from recording a recurring expense of a suspended payer, and records its days once reinstated', async () => {
    const { ann, ben, cy, groupId } = await threeInAGroup();
    const admin = await administrator();
    const set = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: ben.token,
      body: { description: 'Rent', amount: 1001, startsOn: DAY, splitBetween: [ann.id, ben.id, cy.id] },
    });
    const recurringId = (set.body as { id: string }).id;
    await suspend(admin, ben.id);

    await app.runJobs();
    now = Date.parse('2026-12-10T09:00:00.000Z');
    await app.runJobs();
    const rent = async () =>
      (
        (await send(app, 'GET', `/groups/${groupId}/expenses`, { token: ann.token })).body as {
          description: string;
          paidBy: string;
          date: string;
        }[]
      ).filter(expense => expense.description === 'Rent');
    expect(await rent()).toEqual([]);
    expect((await send(app, 'GET', `/recurring/${recurringId}`, { token: ann.token })).body).toMatchObject({
      next: DAY,
    });

    await reinstate(admin, ben.id);
    await app.runJobs();
    const recorded = await rent();
    expect(recorded.map(expense => expense.date).sort()).toEqual([DAY, '2026-12-10']);
    expect(recorded.every(expense => expense.paidBy === ben.id)).toBe(true);
  });

  it('logs each suspension and each reinstatement to the administrators, once, and a change that changes nothing is no entry', async () => {
    const { ben, cy } = await threeInAGroup();
    const admin = await administrator();
    await suspend(admin, ben.id);
    await suspend(admin, ben.id);
    await reinstate(admin, ben.id);
    await reinstate(admin, ben.id);
    await reinstate(admin, cy.id);

    const log = (await send(app, 'GET', '/admin/log', { token: admin.token })).body as {
      action: string;
      subjectId: string;
      by: string;
    }[];
    expect(log.map(entry => [entry.action, entry.subjectId, entry.by])).toEqual([
      ['suspended', ben.id, admin.id],
      ['reinstated', ben.id, admin.id],
    ]);
  });

  it("takes a database created before suspensions, whose administrators' log lacks their actions, and lets an account be suspended in it", async () => {
    const { ben } = await threeInAGroup();
    const admin = await administrator();
    await app.stop();
    // The database as one created before suspensions had it: no table for them, and the log's CHECK without their actions.
    const client = new pg.Client({ connectionString: directory.databaseUrl });
    await client.connect();
    try {
      await client.query('DROP TABLE suspensions');
      await client.query(
        `ALTER TABLE admin_log DROP CONSTRAINT admin_log_action_check,
           ADD CONSTRAINT admin_log_action_check CHECK (action IN ('decided-paid', 'decided-annulled'))`,
      );
    } finally {
      await client.end();
    }
    app = await createApplication({
      databaseUrl: directory.databaseUrl,
      adminEmails: ADMIN_EMAILS,
      clock: () => new Date(now),
    });
    await app.start(0);

    await suspend(admin, ben.id);
    const log = (await send(app, 'GET', '/admin/log', { token: admin.token })).body as { action: string }[];
    expect(log.map(entry => entry.action)).toEqual(['suspended']);
  });

  it('lets a reinstated account record what it could not while suspended', async () => {
    const { ann, ben, groupId } = await threeInAGroup();
    const admin = await administrator();
    await suspend(admin, ben.id);
    const refused = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ben.token,
      body: { description: 'Taxi', amount: 500, date: DAY, splitBetween: [ann.id, ben.id] },
    });
    expect(refused.status).toBe(403);
    await reinstate(admin, ben.id);
    const recorded = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ben.token,
      body: { description: 'Taxi', amount: 500, date: DAY, splitBetween: [ann.id, ben.id] },
    });
    expect(recorded.status).toBe(201);
  });
});
