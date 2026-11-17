import type { DatabaseSync } from 'node:sqlite';
import type { Application } from './app';
import { openDatabase } from './database';
import { send, signedUpAccount, startApplication, testDirectory, type TestDirectory } from './test-helpers';

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

describe('settling up in cash', () => {
  let directory: TestDirectory;
  let app: Application;
  let db: DatabaseSync;

  beforeEach(async () => {
    directory = testDirectory();
    app = await startApplication(directory.databasePath);
    // A second connection to the same file, to count what was stored.
    db = openDatabase(directory.databasePath);
  });

  afterEach(async () => {
    db.close();
    await app.stop();
    directory.remove();
  });

  /** Creates a group as `token`'s account and answers its id. */
  async function createGroup(token: string): Promise<string> {
    const reply = await send(app, 'POST', '/groups', { token, body: { name: 'Trip', currency: 'EUR' } });
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

  /** Records an expense split equally between `splitBetween`, as `token`'s account; it must be accepted. */
  async function recordEqual(token: string, groupId: string, amount: number, splitBetween: string[]): Promise<void> {
    const reply = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      body: { description: 'Dinner', amount, date: utcDay(0), splitBetween },
    });
    if (reply.status !== 201) throw new Error(`record answered ${reply.status}`);
  }

  /** Records a cash settlement as `payeeToken`'s account, paid by `from`. */
  async function settle(payeeToken: string, groupId: string, from: string, amount: number) {
    return send(app, 'POST', `/groups/${groupId}/settlements/cash`, { token: payeeToken, body: { from, amount } });
  }

  /** The balances of `groupId`, read as `token`'s account, as a map from member to balance. */
  async function balancesAs(token: string, groupId: string): Promise<Record<string, number>> {
    const reply = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    const rows = reply.body as { memberId: string; balance: number }[];
    return Object.fromEntries(rows.map(row => [row.memberId, row.balance]));
  }

  /** Ann creates a group with Ben, and Ann pays 3000 split equally: Ben owes Ann 1500. Answers the ids. */
  async function annAndBenOwing1500() {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const groupId = await createGroup(ann.token);
    await join(ann.token, groupId, ben.token);
    await recordEqual(ann.token, groupId, 3000, [ann.id, ben.id]);
    return { ann, ben, groupId };
  }

  it('records a settlement the payee made, and reads it back with its payer, payee, amount, method and status', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const recorded = await settle(ann.token, groupId, ben.id, 1500);
    expect(recorded.status).toBe(201);
    const id = (recorded.body as { id: string }).id;
    const read = await send(app, 'GET', `/settlements/${id}`, { token: ben.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id,
      groupId,
      from: ben.id,
      to: ann.id,
      amount: 1500,
      method: 'cash',
      status: 'paid',
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/),
      history: [{ status: 'paid', at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/) }],
    });
    expect((await send(app, 'GET', `/settlements/${id}`, { token: ann.token })).body).toEqual(read.body);
  });

  it('counts a settlement in the balances at once: the payer’s rises by it, the payee’s falls, and they add up to 0', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1500, [ben.id]: -1500 });
    expect((await settle(ann.token, groupId, ben.id, 1000)).status).toBe(201);
    expect(await balancesAs(ben.token, groupId)).toEqual({ [ann.id]: 500, [ben.id]: -500 });
    expect((await settle(ann.token, groupId, ben.id, 500)).status).toBe(201);
    const balances = await balancesAs(ann.token, groupId);
    expect(balances).toEqual({ [ann.id]: 0, [ben.id]: 0 });
    expect(Object.values(balances).reduce((sum, balance) => sum + balance, 0)).toBe(0);
  });

  it('refuses an amount more than the payer owes, or more than the payee is owed, and changes nothing', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const tooMuch = await settle(ann.token, groupId, ben.id, 1501);
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body).toMatchObject({ error: 'AmountExceedsBalance' });
    // A third member who owes nothing cannot pay anything: the amount is more than they owe.
    const cy = await signedUpAccount(app, { email: 'cy@example.org', name: 'Cy' });
    await join(ann.token, groupId, cy.token);
    expect((await settle(ann.token, groupId, cy.id, 1)).body).toMatchObject({ error: 'AmountExceedsBalance' });
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1500, [ben.id]: -1500, [cy.id]: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM settlements').get()).toEqual({ n: 0 });
  });

  it('refuses a payer who is owed money rather than owing it, and a payer who is the payee', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    // Ann is owed 1500 and owes nothing, so Ben cannot be paid by her: the payer owes Ben nothing to settle.
    const owedToPayer = await settle(ben.token, groupId, ann.id, 1);
    expect(owedToPayer.status).toBe(409);
    expect(owedToPayer.body).toMatchObject({ error: 'AmountExceedsBalance' });
    // The member who records a settlement cannot be the one who paid it.
    const selfPaid = await settle(ann.token, groupId, ann.id, 1);
    expect(selfPaid.status).toBe(422);
    expect(selfPaid.body).toMatchObject({ error: 'PayerIsPayee' });
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1500, [ben.id]: -1500 });
  });

  it('refuses a payer who is not a member of the group, and a payee who is not a member of the group', async () => {
    const { ann, groupId } = await annAndBenOwing1500();
    const outsider = await signedUpAccount(app, { email: 'out@example.org', name: 'Out' });
    const notMember = await settle(ann.token, groupId, outsider.id, 1);
    expect(notMember.status).toBe(422);
    expect(notMember.body).toMatchObject({ error: 'PayerNotInGroup' });
    // A caller who is not a member sees no group to settle in.
    const asOutsider = await settle(outsider.token, groupId, outsider.id, 1);
    expect(asOutsider.status).toBe(404);
    expect(asOutsider.body).toMatchObject({ error: 'GroupNotFound' });
  });

  it('refuses an amount that is not a whole number from 1, and a body that is not shaped as asked', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    for (const amount of [0, -5, 1.5]) {
      const reply = await settle(ann.token, groupId, ben.id, amount);
      expect(reply.status).toBe(422);
      expect(reply.body).toMatchObject({ error: 'AmountIsInvalid' });
    }
    const asText = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: ben.id, amount: '1500' },
    });
    expect(asText.status).toBe(400);
    const noPayer = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { amount: 1500 },
    });
    expect(noPayer.status).toBe(400);
    expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 1500, [ben.id]: -1500 });
  });

  it('answers 401 to a request with no token, or an unproven one', async () => {
    const { ben, groupId } = await annAndBenOwing1500();
    const body = { from: ben.id, amount: 1 };
    expect((await send(app, 'POST', `/groups/${groupId}/settlements/cash`, { body })).status).toBe(401);
    expect(
      (await send(app, 'POST', `/groups/${groupId}/settlements/cash`, { body, token: 'not-a-real-token' })).status,
    ).toBe(401);
  });

  it('lets two settlements recorded at once decide on the balances the other left: one is kept, one refused', async () => {
    // Ben owes Ann 1500, and no more. Two settlements of 1500 from Ben to Ann would each be right on their
    // own, but together they pay more than is owed: when both are recorded at once, exactly one is kept.
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const groupId = await createGroup(ann.token);
    await join(ann.token, groupId, ben.token);
    await recordEqual(ann.token, groupId, 3000, [ann.id, ben.id]);
    // A second connection on the same file, served by a second application: two servers, one database.
    const other = await startApplication(directory.databasePath);
    try {
      const [first, second] = await Promise.all([
        send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
          token: ann.token,
          body: { from: ben.id, amount: 1500 },
        }),
        send(other, 'POST', `/groups/${groupId}/settlements/cash`, {
          token: ann.token,
          body: { from: ben.id, amount: 1500 },
        }),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
      expect(await balancesAs(ann.token, groupId)).toEqual({ [ann.id]: 0, [ben.id]: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM settlements').get()).toEqual({ n: 1 });
    } finally {
      await other.stop();
    }
  });

  it('answers 404 to a settlement that does not exist, and to one read by someone who is not a member of its group', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    const id = (await settle(ann.token, groupId, ben.id, 1500)).body as { id: string };
    const outsider = await signedUpAccount(app, { email: 'out@example.org', name: 'Out' });
    const notMember = await send(app, 'GET', `/settlements/${id.id}`, { token: outsider.token });
    const missing = await send(app, 'GET', '/settlements/no-such-settlement', { token: ann.token });
    expect(notMember.status).toBe(404);
    expect(notMember.body).toMatchObject({ error: 'SettlementNotFound' });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(notMember.body);
    expect((await send(app, 'GET', `/settlements/${id.id}`)).status).toBe(401);
  });

  it('leaves the suggested settlements to count it, so that a settled pair has none', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    expect((await send(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token: ann.token })).body).toEqual([
      { from: ben.id, to: ann.id, amount: 1500 },
    ]);
    await settle(ann.token, groupId, ben.id, 500);
    expect((await send(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token: ben.token })).body).toEqual([
      { from: ben.id, to: ann.id, amount: 1000 },
    ]);
    await settle(ann.token, groupId, ben.id, 1000);
    expect((await send(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token: ben.token })).body).toEqual([]);
  });

  it('lets a member who settled up to a balance of 0 leave the group', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: ben.token })).status).toBe(409);
    await settle(ann.token, groupId, ben.id, 1500);
    expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: ben.token })).status).toBe(204);
  });

  it('keeps a member’s statement to the expenses alone, so its balance can differ from the balance in the group', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    await settle(ann.token, groupId, ben.id, 1500);
    const statement = await send(app, 'GET', `/groups/${groupId}/members/${ben.id}/statement`, { token: ann.token });
    expect(statement.body).toEqual({
      memberId: ben.id,
      balance: -1500,
      entries: [
        {
          expenseId: expect.any(String),
          date: utcDay(0),
          description: 'Dinner',
          paid: 0,
          share: 1500,
          balance: -1500,
        },
      ],
    });
    expect((await balancesAs(ann.token, groupId))[ben.id]).toBe(0);
  });

  it('stores one settlement per recording, and nothing for a read', async () => {
    const { ann, ben, groupId } = await annAndBenOwing1500();
    await settle(ann.token, groupId, ben.id, 500);
    const before = db.prepare('SELECT COUNT(*) AS n FROM settlements').get();
    await send(app, 'GET', `/groups/${groupId}/balances`, { token: ann.token });
    await send(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token: ben.token });
    expect(db.prepare('SELECT COUNT(*) AS n FROM settlements').get()).toEqual(before);
    expect(before).toEqual({ n: 1 });
  });
});
