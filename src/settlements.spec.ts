import type { Application } from './app';
import type { Balance } from './balances';
import { type Database, openDatabase } from './database';
import { send, signedUpAccount, startApplication, testDirectory, type TestDirectory } from './test-helpers';
import { suggestTransfers, type Transfer } from './settlements';

/** Applies transfers to balances: the payer's balance rises by the amount, the payee's falls by it. */
function applyTransfers(balances: Balance[], transfers: Transfer[]): Map<string, number> {
  const result = new Map(balances.map(({ memberId, balance }) => [memberId, balance]));
  for (const { from, to, amount } of transfers) {
    result.set(from, (result.get(from) ?? 0) + amount);
    result.set(to, (result.get(to) ?? 0) - amount);
  }
  return result;
}

describe('the algorithm of suggested settlements', () => {
  it('makes the transfers of the feature’s example, in the order made', async () => {
    // Ann 500, Ben 100, Cy −300, Dan −300, in the order they joined.
    const balances: Balance[] = [
      { memberId: 'ann', balance: 500 },
      { memberId: 'ben', balance: 100 },
      { memberId: 'cy', balance: -300 },
      { memberId: 'dan', balance: -300 },
    ];
    expect(suggestTransfers(balances)).toEqual([
      { from: 'cy', to: 'ann', amount: 300 },
      { from: 'dan', to: 'ann', amount: 200 },
      { from: 'dan', to: 'ben', amount: 100 },
    ]);
  });

  it('makes no transfer when every balance is already 0', async () => {
    expect(
      suggestTransfers([
        { memberId: 'ann', balance: 0 },
        { memberId: 'ben', balance: 0 },
      ]),
    ).toEqual([]);
    expect(suggestTransfers([])).toEqual([]);
  });

  it('takes the member who joined first when two owe the same, and when two are owed the same', async () => {
    // Ben and Cy both owe 100, Ann and Dan are both owed 100; the earlier of each pair is taken first.
    const balances: Balance[] = [
      { memberId: 'ann', balance: 100 },
      { memberId: 'ben', balance: -100 },
      { memberId: 'cy', balance: -100 },
      { memberId: 'dan', balance: 100 },
    ];
    expect(suggestTransfers(balances)).toEqual([
      { from: 'ben', to: 'ann', amount: 100 },
      { from: 'cy', to: 'dan', amount: 100 },
    ]);
  });

  it('settles every balance to 0 with at most one transfer fewer than the members not at 0', async () => {
    const balances: Balance[] = [
      { memberId: 'a', balance: 700 },
      { memberId: 'b', balance: -120 },
      { memberId: 'c', balance: 0 },
      { memberId: 'd', balance: -380 },
      { memberId: 'e', balance: 240 },
      { memberId: 'f', balance: -440 },
    ];
    const transfers = suggestTransfers(balances);
    expect(transfers.length).toBeLessThanOrEqual(5 - 1);
    for (const transfer of transfers) expect(transfer.amount).toBeGreaterThan(0);
    const settled = applyTransfers(balances, transfers);
    expect([...settled.values()].every(balance => balance === 0)).toBe(true);
  });

  it('does not change the balances it is given', async () => {
    const balances: Balance[] = [
      { memberId: 'ann', balance: 50 },
      { memberId: 'ben', balance: -50 },
    ];
    suggestTransfers(balances);
    expect(balances).toEqual([
      { memberId: 'ann', balance: 50 },
      { memberId: 'ben', balance: -50 },
    ]);
  });
});

describe('suggested settlements of a group', () => {
  let directory: TestDirectory;
  let app: Application;
  let db: Database;

  beforeEach(async () => {
    directory = testDirectory();
    app = await startApplication(directory.databaseUrl);
    // A second connection to the same file, to count what was stored.
    db = await openDatabase({ url: directory.databaseUrl });
  });

  afterEach(async () => {
    await db.close();
    await app.stop();
    await directory.remove();
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

  /** Records an expense split by exact amounts, as `token`'s account; it must be accepted. */
  async function recordExact(
    token: string,
    groupId: string,
    amount: number,
    splitExactly: { memberId: string; amount: number }[],
  ): Promise<void> {
    const reply = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      body: { description: 'Dinner', amount, date: utcDay(0), splitExactly },
    });
    if (reply.status !== 201) throw new Error(`record answered ${reply.status}`);
  }

  /** The suggested settlement of `groupId`, read as `token`'s account. */
  async function suggestionAs(token: string, groupId: string) {
    return send(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token });
  }

  /** How many expenses and shares the file holds, read on the second connection. */
  async function storedCounts(): Promise<{ expenses: number; shares: number; memberships: number }> {
    const expenses = (await db.prepare('SELECT COUNT(*) AS n FROM expenses').get()) as { n: number };
    const shares = (await db.prepare('SELECT COUNT(*) AS n FROM expense_shares').get()) as { n: number };
    const memberships = (await db.prepare('SELECT COUNT(*) AS n FROM group_members').get()) as { n: number };
    return { expenses: expenses.n, shares: shares.n, memberships: memberships.n };
  }

  it('answers the transfers of the feature’s example, read by each member', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const cy = await signedUpAccount(app, { email: 'cy@example.org', name: 'Cy' });
    const dan = await signedUpAccount(app, { email: 'dan@example.org', name: 'Dan' });
    const groupId = await createGroup(ann.token);
    await join(ann.token, groupId, ben.token);
    await join(ann.token, groupId, cy.token);
    await join(ann.token, groupId, dan.token);
    // Ann pays 1000 in shares of 500 (Ann), 100 (Ben), 300 (Cy), 100 (Dan): Ann is owed 500, Ben owes 100.
    await recordExact(ann.token, groupId, 1000, [
      { memberId: ann.id, amount: 500 },
      { memberId: ben.id, amount: 100 },
      { memberId: cy.id, amount: 300 },
      { memberId: dan.id, amount: 100 },
    ]);
    // Ben pays 200 for Dan alone: Ben is owed 200, Dan owes 200.
    await recordExact(ben.token, groupId, 200, [
      { memberId: ben.id, amount: 0 },
      { memberId: dan.id, amount: 200 },
    ]);
    const expected = [
      { from: cy.id, to: ann.id, amount: 300 },
      { from: dan.id, to: ann.id, amount: 200 },
      { from: dan.id, to: ben.id, amount: 100 },
    ];
    expect((await suggestionAs(ann.token, groupId)).body).toEqual(expected);
    expect((await suggestionAs(dan.token, groupId)).body).toEqual(expected);
  });

  it('answers the transfers the balances need, and settles every balance of the group to 0', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const cy = await signedUpAccount(app, { email: 'cy@example.org', name: 'Cy' });
    const groupId = await createGroup(ann.token);
    await join(ann.token, groupId, ben.token);
    await join(ann.token, groupId, cy.token);
    await recordEqual(ann.token, groupId, 1000, [ann.id, ben.id, cy.id]);
    await recordEqual(cy.token, groupId, 600, [cy.id, ben.id]);
    const balances = (await send(app, 'GET', `/groups/${groupId}/balances`, { token: ann.token })).body as Balance[];
    const transfers = (await suggestionAs(ann.token, groupId)).body as Transfer[];
    expect(transfers).toEqual(suggestTransfers(balances));
    const settled = applyTransfers(balances, transfers);
    expect([...settled.values()]).toEqual([0, 0, 0]);
  });

  it('answers no transfer for a group whose members are all even', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const groupId = await createGroup(ann.token);
    await join(ann.token, groupId, ben.token);
    expect((await suggestionAs(ann.token, groupId)).body).toEqual([]);
    await recordEqual(ann.token, groupId, 1000, [ann.id, ben.id]);
    await recordEqual(ben.token, groupId, 1000, [ann.id, ben.id]);
    expect((await suggestionAs(ben.token, groupId)).body).toEqual([]);
  });

  it('answers the same suggestion to every member of the group', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const cy = await signedUpAccount(app, { email: 'cy@example.org', name: 'Cy' });
    const groupId = await createGroup(ann.token);
    await join(ann.token, groupId, ben.token);
    await join(ann.token, groupId, cy.token);
    await recordEqual(ben.token, groupId, 1001, [ann.id, ben.id, cy.id]);
    const asAnn = await suggestionAs(ann.token, groupId);
    const asCy = await suggestionAs(cy.token, groupId);
    expect(asAnn.body).toEqual(asCy.body);
    expect(asAnn.body).not.toEqual([]);
  });

  it('changes nothing stored, however often it is read', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const groupId = await createGroup(ann.token);
    await join(ann.token, groupId, ben.token);
    await recordEqual(ann.token, groupId, 1000, [ann.id, ben.id]);
    const before = await storedCounts();
    const balancesBefore = (await send(app, 'GET', `/groups/${groupId}/balances`, { token: ann.token })).body;
    const first = await suggestionAs(ann.token, groupId);
    const second = await suggestionAs(ben.token, groupId);
    expect(second.body).toEqual(first.body);
    expect(await storedCounts()).toEqual(before);
    expect((await send(app, 'GET', `/groups/${groupId}/balances`, { token: ann.token })).body).toEqual(balancesBefore);
  });

  it('leaves out a member who left the group, once their balance was 0', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const cy = await signedUpAccount(app, { email: 'cy@example.org', name: 'Cy' });
    const groupId = await createGroup(ann.token);
    await join(ann.token, groupId, ben.token);
    await join(ann.token, groupId, cy.token);
    // Cy is in no split: the balance is 0, and Cy may leave.
    await recordEqual(ann.token, groupId, 1000, [ann.id, ben.id]);
    expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: cy.token })).status).toBe(204);
    expect((await suggestionAs(ann.token, groupId)).body).toEqual([{ from: ben.id, to: ann.id, amount: 500 }]);
    // A member who left no longer reads the group's suggestion.
    expect((await suggestionAs(cy.token, groupId)).status).toBe(404);
  });

  it('answers 404 to a signed-in account that is not a member, as if the group did not exist', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const groupId = await createGroup(ann.token);
    const outsider = await suggestionAs(ben.token, groupId);
    const missing = await suggestionAs(ben.token, 'no-such-group');
    expect(outsider.status).toBe(404);
    expect(outsider.body).toMatchObject({ error: 'GroupNotFound' });
    expect(outsider.body).toEqual(missing.body);
  });

  it('refuses a request with no token, or an unproven one, with 401', async () => {
    const ann = await signedUpAccount(app, { email: 'ann@example.org', name: 'Ann' });
    const groupId = await createGroup(ann.token);
    expect((await send(app, 'GET', `/groups/${groupId}/settlements/suggested`)).status).toBe(401);
    expect((await suggestionAs('not-a-real-token', groupId)).status).toBe(401);
  });
});

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}
