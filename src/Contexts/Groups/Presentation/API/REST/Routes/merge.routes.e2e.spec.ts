import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Merging two groups, end to end (request 31): the application booted in this process, spoken to over HTTP, every answer held to
 * api/ by the client. One application per suite, shared by its tests in order.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let provider: Server;
/** The payments the fake provider issued, in order: the last one is the payment a test made. */
const issued: string[] = [];
const SECRET = 'whsec_merge';

beforeAll(async () => {
  // A fake payment provider in this process, started before the application, so PROVIDER_URL is the one the application reads.
  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
    let text = '';
    req.on('data', chunk => (text += chunk));
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.startsWith('/accounts/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ id: decodeURIComponent(req.url.slice('/accounts/'.length)) }));
      }
      issued.push(`pay_merge_${issued.length + 1}`);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: issued[issued.length - 1], payUrl: `https://provider.test/pay/${issued.length}` }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});
afterAll(async () => {
  await app.stop();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
});

const PASSWORD = 'correct horse';

/** Signs an account up and in, and answers its token and its id. */
async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

/** A group founded by its owner in a currency. */
async function groupIn(owner: { token: string }, name: string, currency = 'EUR'): Promise<string> {
  const created = await http.request('POST', '/v1/groups', { body: { name, currency }, token: owner.token });
  return (created.body as { id: string }).id;
}

/** An invitation to the group by its owner, accepted by the member. */
async function joins(groupId: string, owner: { token: string }, member: { token: string }): Promise<void> {
  const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
  const invitationId = (invitation.body as { id: string }).id;
  await http.request('POST', `/v1/invitations/${invitationId}/accept`, { token: member.token });
}

/** A group of an owner and one member, in EUR. */
async function groupWith(owner: { token: string }, member: { token: string }, name: string): Promise<string> {
  const groupId = await groupIn(owner, name);
  await joins(groupId, owner, member);
  return groupId;
}

const merge = (groupId: string, from: string, token?: string) =>
  http.request('POST', `/v1/groups/${groupId}/merge`, { body: { from }, token });
const getGroup = (groupId: string, token?: string) => http.get(`/v1/groups/${groupId}`, { token });
const members = async (groupId: string, token: string) =>
  (await http.get(`/v1/groups/${groupId}/members`, { token })).body as { memberId: string; role: string }[];
const expensesOf = async (groupId: string, token: string) =>
  (await http.get(`/v1/groups/${groupId}/expenses`, { token })).body as { id: string }[];
const balancesOf = async (groupId: string, token: string) =>
  (await http.get(`/v1/groups/${groupId}/balances`, { token })).body as { memberId: string; balance: number }[];

/** An expense paid by `payer`, split exactly as given. */
const recordExpense = (
  groupId: string,
  payer: { token: string },
  split: { memberId: string; amount: number }[],
  amount: number,
) =>
  http.request('POST', `/v1/groups/${groupId}/expenses`, {
    token: payer.token,
    body: { description: 'Dinner', amount, date: '2026-01-10', splitExactly: split },
  });

/** Reads until the read holds, for the reactions of a merge run within a few seconds after the merge. */
async function eventually<T>(read: () => Promise<T>, holds: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 50 && !holds(value); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    value = await read();
  }
  return value;
}

describe('merging a group into another', () => {
  it('moves the members, the expenses and the balances to the group kept, and the group merged is gone', async () => {
    const ana = await accountOf('ana.merge@example.com', 'Ana');
    const ben = await accountOf('ben.merge@example.com', 'Ben');
    const cleo = await accountOf('cleo.merge@example.com', 'Cleo');
    const dave = await accountOf('dave.merge@example.com', 'Dave');

    const rent = await groupWith(ana, ben, 'Rent');
    const groceries = await groupWith(ana, cleo, 'Groceries');
    await joins(groceries, ana, dave);
    expect((await http.request('POST', `/v1/groups/${groceries}/leave`, { token: dave.token })).status).toBe(201);

    expect(
      (
        await recordExpense(
          groceries,
          ana,
          [
            { memberId: ana.id, amount: 30 },
            { memberId: cleo.id, amount: 30 },
          ],
          60,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await recordExpense(
          rent,
          ben,
          [
            { memberId: ana.id, amount: 50 },
            { memberId: ben.id, amount: 50 },
          ],
          100,
        )
      ).status,
    ).toBe(201);

    const merged = await merge(rent, groceries, ana.token);
    expect(merged.status).toBe(201);
    expect(merged.body).toEqual({ id: rent });

    // The group merged is gone for everyone.
    expect((await getGroup(groceries, ana.token)).status).toBe(404);
    expect((await getGroup(groceries, cleo.token)).status).toBe(404);

    // Its members join after the group kept's, in the order they joined the group merged; a member of both stays where they are.
    const after = await members(rent, ana.token);
    expect(after.map(member => member.memberId)).toEqual([ana.id, ben.id, cleo.id]);
    expect(after.find(member => member.memberId === cleo.id)?.role).toBe('member');

    // Its expenses are the group kept's, and its balances add up to 0 with both of them counted.
    const expenses = await eventually(
      () => expensesOf(rent, ana.token),
      list => list.length === 2,
    );
    expect(expenses).toHaveLength(2);
    const balances = await eventually(
      () => balancesOf(rent, ana.token),
      list => list.length === 3 && list.find(member => member.memberId === ana.id)?.balance === -20,
    );
    const balanceOf = (memberId: string) => balances.find(member => member.memberId === memberId)?.balance ?? 0;
    expect(balanceOf(ana.id)).toBe(-20);
    expect(balanceOf(ben.id)).toBe(50);
    expect(balanceOf(cleo.id)).toBe(-30);
    expect(balances.reduce((sum, member) => sum + member.balance, 0)).toBe(0);

    // A former member of the group merged is a former member of the group kept: their statement is read there.
    const statement = await http.get(`/v1/groups/${rent}/members/${dave.id}/statement`, { token: ana.token });
    expect(statement.status).toBe(200);
  });

  it('refuses a merge by currency, by a caller who does not own both, by a stranger, into itself, and of an archived group; and changes nothing', async () => {
    const ana = await accountOf('ana.refuse@example.com', 'Ana');
    const ben = await accountOf('ben.refuse@example.com', 'Ben');
    const cleo = await accountOf('cleo.refuse@example.com', 'Cleo');

    const kept = await groupWith(ana, ben, 'Kept');
    const otherCurrency = await groupIn(ana, 'Dollars', 'USD');
    await joins(otherCurrency, ana, ben);
    const notOwned = await groupWith(ben, ana, 'Ben owns this');
    const archived = await groupWith(ana, ben, 'Archived');
    expect((await http.request('POST', `/v1/groups/${archived}/archive`, { token: ana.token })).status).toBe(201);

    const currency = await merge(kept, otherCurrency, ana.token);
    expect(currency.status).toBe(409);
    expect(currency.body).toMatchObject({ type: 'CurrenciesDiffer' });

    const notOwner = await merge(kept, notOwned, ben.token);
    expect(notOwner.status).toBe(403);
    expect(notOwner.body).toMatchObject({ type: 'NotAllowed' });

    const stranger = await merge(kept, notOwned, cleo.token);
    expect(stranger.status).toBe(404);

    const itself = await merge(kept, kept, ana.token);
    expect(itself.status).toBe(400);
    expect(itself.body).toMatchObject({ type: 'GroupMergeIntoItself' });

    const archivedMerged = await merge(kept, archived, ana.token);
    expect(archivedMerged.status).toBe(409);
    expect(archivedMerged.body).toMatchObject({ type: 'GroupArchived' });

    const archivedKept = await merge(archived, kept, ana.token);
    expect(archivedKept.status).toBe(409);
    expect(archivedKept.body).toMatchObject({ type: 'GroupArchived' });

    // Nothing changed: every group is still there, and the kept one keeps its members.
    expect((await getGroup(otherCurrency, ana.token)).status).toBe(200);
    expect((await getGroup(notOwned, ben.token)).status).toBe(200);
    expect((await members(kept, ana.token)).map(member => member.memberId)).toEqual([ana.id, ben.id]);
  });

  it('refuses an invitation of the group merged, and an expense recorded in it, once it is merged', async () => {
    const ana = await accountOf('ana.gone@example.com', 'Ana');
    const ben = await accountOf('ben.gone@example.com', 'Ben');
    const cleo = await accountOf('cleo.gone@example.com', 'Cleo');

    const kept = await groupWith(ana, ben, 'Kept again');
    const merged = await groupWith(ana, ben, 'Merged again');
    const invitation = await http.request('POST', `/v1/groups/${merged}/invitations`, { token: ana.token });
    const invitationId = (invitation.body as { id: string }).id;

    expect((await merge(kept, merged, ana.token)).status).toBe(201);

    const accepted = await http.request('POST', `/v1/invitations/${invitationId}/accept`, { token: cleo.token });
    expect(accepted.status).toBe(404);

    const recorded = await recordExpense(
      merged,
      ana,
      [
        { memberId: ana.id, amount: 10 },
        { memberId: ben.id, amount: 10 },
      ],
      20,
    );
    expect(recorded.status).toBe(404);

    const onKept = await recordExpense(
      kept,
      ana,
      [
        { memberId: ana.id, amount: 10 },
        { memberId: ben.id, amount: 10 },
      ],
      20,
    );
    expect(onKept.status).toBe(201);
  });
});

const setPayoutAccount = (token: string, accountId: string) =>
  http.request('PUT', '/v1/accounts/me/payout-account', { body: { accountId }, token });
const payThroughProvider = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/settlements/provider`, { body, token });
const settleInCash = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/settlements/cash`, { body, token });
const settlementOf = (settlementId: string, token: string) => http.get(`/v1/settlements/${settlementId}`, { token });

/** The provider's webhook, signed as the provider signs it: HMAC-SHA256 of the body as sent, in lowercase hex. */
const webhook = (paymentId: string, status: string) => {
  const body = { id: `wh_${paymentId}_${status}`, at: '2026-11-17T10:00:00Z', paymentId, status };
  return http.request('POST', '/v1/provider/webhooks', {
    body,
    headers: { 'provider-signature': createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex') },
  });
};

describe('Groups → Ledger', () => {
  it('merges a group in Groups, answers the group kept by its id, and Ledger reads the expense moved into it by that id', async () => {
    const ana = await accountOf('ana.merge.ledger@example.com', 'Ana');
    const ben = await accountOf('ben.merge.ledger@example.com', 'Ben');
    const cleo = await accountOf('cleo.merge.ledger@example.com', 'Cleo');
    const kept = await groupWith(ana, ben, 'Kept for Ledger');
    const merged = await groupWith(ana, cleo, 'Merged for Ledger');
    const recorded = await recordExpense(
      merged,
      ana,
      [
        { memberId: ana.id, amount: 30 },
        { memberId: cleo.id, amount: 30 },
      ],
      60,
    );
    const expenseId = (recorded.body as { id: string }).id;

    const answered = await merge(kept, merged, ana.token);
    expect(answered.status).toBe(201);
    const keptId = (answered.body as { id: string }).id;
    expect(keptId).toBe(kept);

    const expense = await eventually(
      () => http.get(`/v1/expenses/${expenseId}`, { token: ana.token }),
      read => (read.body as { groupId?: string }).groupId === keptId,
    );
    expect(expense.body).toMatchObject({ id: expenseId, groupId: keptId });
  });
});

describe('Groups → Settlements', () => {
  it('merges a group in Groups, answers the group kept by its id, and Settlements lists the settlement moved into it by that id', async () => {
    const ana = await accountOf('ana.merge.settlements@example.com', 'Ana');
    const ben = await accountOf('ben.merge.settlements@example.com', 'Ben');
    const kept = await groupWith(ana, ben, 'Kept for Settlements');
    const merged = await groupWith(ana, ben, 'Merged for Settlements');
    await recordExpense(
      merged,
      ana,
      [
        { memberId: ana.id, amount: 50 },
        { memberId: ben.id, amount: 50 },
      ],
      100,
    );
    const paid = await settleInCash(merged, ana.token, { from: ben.id, amount: 50 });
    expect(paid.status).toBe(201);
    const settlementId = (paid.body as { id: string }).id;

    const answered = await merge(kept, merged, ana.token);
    expect(answered.status).toBe(201);
    const keptId = (answered.body as { id: string }).id;

    const listed = await eventually(
      () => http.get(`/v1/groups/${keptId}/settlements`, { token: ana.token }),
      read => (read.body as { id: string }[]).some(settlement => settlement.id === settlementId),
    );
    expect(listed.body as { id: string; groupId: string; status: string }[]).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: settlementId, groupId: keptId, status: 'paid' })]),
    );
  });
});

describe('Settlements → Groups', () => {
  it('makes a payment through the provider in Settlements, and Groups refuses the merge while it waits, then allows it once it has succeeded', async () => {
    const ana = await accountOf('ana.merge.provider@example.com', 'Ana');
    const ben = await accountOf('ben.merge.provider@example.com', 'Ben');
    const kept = await groupWith(ana, ben, 'Kept for provider');
    const merged = await groupWith(ana, ben, 'Merged with payment');
    await recordExpense(
      merged,
      ana,
      [
        { memberId: ana.id, amount: 50 },
        { memberId: ben.id, amount: 50 },
      ],
      100,
    );
    expect((await setPayoutAccount(ana.token, 'acct_ana_merge')).status).toBeLessThan(300);

    const asked = await payThroughProvider(merged, ben.token, { to: ana.id, amount: 50 });
    expect(asked.status).toBe(201);
    const settlementId = (asked.body as { id: string }).id;
    const paymentId = issued[issued.length - 1];

    const refused = await merge(kept, merged, ana.token);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ type: 'GroupMergePaymentWaiting' });
    expect((await getGroup(merged, ana.token)).status).toBe(200);
    expect((await settlementOf(settlementId, ana.token)).body).toMatchObject({
      id: settlementId,
      groupId: merged,
      status: 'pending',
    });

    expect((await webhook(paymentId, 'succeeded')).status).toBeGreaterThanOrEqual(200);
    const allowed = await eventually(
      () => merge(kept, merged, ana.token),
      answer => answer.status === 201,
    );
    expect(allowed.status).toBe(201);
    expect((allowed.body as { id: string }).id).toBe(kept);
    const moved = await eventually(
      () => settlementOf(settlementId, ana.token),
      read => (read.body as { groupId?: string }).groupId === kept,
    );
    expect(moved.body).toMatchObject({ id: settlementId, groupId: kept, status: 'paid' });
  });
});
