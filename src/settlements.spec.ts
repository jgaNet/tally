import { openDatabase } from './database';
import { Application } from './app';
import { suggestSettlements, Transfer } from './settlements';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };

const PAST_DAY = '2026-11-01';

/** Applies the transfers to the balances, as they are in the order of joining: what is left, per member. */
function applied(balances: { memberId: string; balance: number }[], transfers: Transfer[]): Map<string, number> {
  const left = new Map(balances.map(row => [row.memberId, row.balance]));
  for (const transfer of transfers) {
    left.set(transfer.from, (left.get(transfer.from) ?? 0) + transfer.amount);
    left.set(transfer.to, (left.get(transfer.to) ?? 0) - transfer.amount);
  }
  return left;
}

/** A small deterministic generator, so the sweeps below are the same on every run. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return state;
  };
}

describe('suggesting settlements: the algorithm', () => {
  it('makes the transfers of the stated example, in the order made', () => {
    // Ann joined first, then Bob, Cy and Dan.
    const balances = [
      { memberId: 'ann', balance: 500 },
      { memberId: 'bob', balance: 100 },
      { memberId: 'cy', balance: -300 },
      { memberId: 'dan', balance: -300 },
    ];
    expect(suggestSettlements(balances)).toEqual([
      { from: 'cy', to: 'ann', amount: 300 },
      { from: 'dan', to: 'ann', amount: 200 },
      { from: 'dan', to: 'bob', amount: 100 },
    ]);
  });

  it('makes no transfer when every balance is already 0', () => {
    expect(suggestSettlements([])).toEqual([]);
    expect(
      suggestSettlements([
        { memberId: 'ann', balance: 0 },
        { memberId: 'bob', balance: 0 },
      ]),
    ).toEqual([]);
  });

  it('takes, among the members who owe the same, the one who joined first', () => {
    // Bob and Cy both owe 50; Bob joined first, so Bob pays first.
    expect(
      suggestSettlements([
        { memberId: 'ann', balance: 100 },
        { memberId: 'bob', balance: -50 },
        { memberId: 'cy', balance: -50 },
      ]),
    ).toEqual([
      { from: 'bob', to: 'ann', amount: 50 },
      { from: 'cy', to: 'ann', amount: 50 },
    ]);
  });

  it('takes, among the members who are owed the same, the one who joined first', () => {
    // Bob and Cy are each owed 50; Bob joined first, so Ann pays Bob first.
    expect(
      suggestSettlements([
        { memberId: 'ann', balance: -100 },
        { memberId: 'bob', balance: 50 },
        { memberId: 'cy', balance: 50 },
      ]),
    ).toEqual([
      { from: 'ann', to: 'bob', amount: 50 },
      { from: 'ann', to: 'cy', amount: 50 },
    ]);
  });

  it('pays the smaller of what is owed and what is owed to, and the next transfer covers the rest', () => {
    expect(
      suggestSettlements([
        { memberId: 'ann', balance: 70 },
        { memberId: 'bob', balance: -100 },
        { memberId: 'cy', balance: 30 },
      ]),
    ).toEqual([
      { from: 'bob', to: 'ann', amount: 70 },
      { from: 'bob', to: 'cy', amount: 30 },
    ]);
  });

  it('makes transfers that bring every balance to 0, never more than the members not at 0 less one, always of at least 1', () => {
    const next = generator(20_261_117);
    for (let round = 0; round < 500; round++) {
      const size = 2 + (next() % 7);
      const raw = Array.from({ length: size }, () => (next() % 2001) - 1000);
      // Balances add up to 0, as the balances of a group always do: the last member takes what is left over.
      const balances = raw.slice(0, -1).map((balance, index) => ({ memberId: `m${index}`, balance }));
      balances.push({ memberId: `m${size - 1}`, balance: -balances.reduce((sum, row) => sum + row.balance, 0) });

      const transfers = suggestSettlements(balances);
      const notAtZero = balances.filter(row => row.balance !== 0).length;
      expect(transfers.length).toBeLessThanOrEqual(Math.max(0, notAtZero - 1));
      for (const transfer of transfers) {
        expect(Number.isInteger(transfer.amount)).toBe(true);
        expect(transfer.amount).toBeGreaterThanOrEqual(1);
      }
      for (const left of applied(balances, transfers).values()) expect(left).toBe(0);
    }
  });

  it('answers the same transfers for the same balances, each time they are computed', () => {
    const balances = [
      { memberId: 'ann', balance: 250 },
      { memberId: 'bob', balance: -75 },
      { memberId: 'cy', balance: -175 },
    ];
    expect(suggestSettlements(balances)).toEqual(suggestSettlements(balances));
  });
});

describe('suggested settlements', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;
  let groupId: string;

  /** Signs the account up and in, and answers its id and token. */
  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  /** Brings the account into the group by an invitation of the owner, and accepts it. */
  async function join(accountToken: string): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    const answer = await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken });
    expect(answer.status).toBe(204);
  }

  /** Records an expense of the group, paid by the account that signs the request with `token`. */
  async function record(token: string, fields: { amount: number; splitBetween: string[] }): Promise<void> {
    const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: { description: 'Expense', date: PAST_DAY, ...fields },
      token,
    });
    expect(answer.status).toBe(201);
  }

  const suggested = (token = adaToken, using: Application = app) =>
    call(using, 'GET', `/groups/${groupId}/settlements/suggested`, { token });

  beforeEach(async () => {
    database = temporaryDatabase();
    app = await startApplication(database.url);
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    await join(graceToken);
    await join(linusToken);
  });

  afterEach(async () => {
    await app.stop();
    await database.remove();
  });

  it('answers no transfer when nothing is recorded, or every member is even', async () => {
    expect(await suggested()).toEqual({ status: 200, body: [] });
    await record(adaToken, { amount: 1000, splitBetween: [adaId, graceId] });
    await record(graceToken, { amount: 1000, splitBetween: [adaId, graceId] });
    expect(await suggested()).toEqual({ status: 200, body: [] });
  });

  it('answers the transfers that bring every balance to 0, from the balances the expenses make', async () => {
    // Ada paid 1000 for three: Ada is owed 666, Grace and Linus each owe 333.
    await record(adaToken, { amount: 1000, splitBetween: [adaId, graceId, linusId] });
    expect(await suggested()).toEqual({
      status: 200,
      body: [
        { from: graceId, to: adaId, amount: 333 },
        { from: linusId, to: adaId, amount: 333 },
      ],
    });
  });

  it('answers the transfers in the order made, with the balances of several expenses', async () => {
    await record(adaToken, { amount: 1000, splitBetween: [adaId, graceId, linusId] });
    await record(graceToken, { amount: 600, splitBetween: [adaId, graceId, linusId] });
    await record(graceToken, { amount: 100, splitBetween: [graceId, linusId] });
    // Balances: Ada 1000 - 334 - 200 = 466; Grace 700 - 333 - 200 - 50 = 117; Linus -(333 + 200 + 50) = -583.
    const balances = (await call(app, 'GET', `/groups/${groupId}/balances`, { token: adaToken })).body;
    expect(balances.map((row: { balance: number }) => row.balance)).toEqual([466, 117, -583]);
    expect((await suggested()).body).toEqual([
      { from: linusId, to: adaId, amount: 466 },
      { from: linusId, to: graceId, amount: 117 },
    ]);
  });

  it('lets every member of the group read the transfers, and they answer the same', async () => {
    await record(adaToken, { amount: 1000, splitBetween: [adaId, graceId, linusId] });
    const fromOwner = (await suggested(adaToken)).body;
    expect((await suggested(graceToken)).body).toEqual(fromOwner);
    expect((await suggested(linusToken)).body).toEqual(fromOwner);
  });

  it('answers 404 to an account outside the group, as if the group did not exist', async () => {
    const outsider = await accountOf(outsiderAccount);
    const notMember = await suggested(outsider.token);
    const missing = await call(app, 'GET', '/groups/no-such-group/settlements/suggested', { token: outsider.token });
    expect(notMember).toEqual({ status: 404, body: { type: 'NotFound', message: expect.any(String) } });
    expect(missing).toEqual(notMember);
  });

  it('answers 401 without a token, and for a token that proves nothing', async () => {
    expect((await call(app, 'GET', `/groups/${groupId}/settlements/suggested`)).status).toBe(401);
    expect((await suggested('made-up-token')).status).toBe(401);
  });

  it('changes nothing that is stored: reading the transfers leaves the rows of the database as they were', async () => {
    await record(adaToken, { amount: 1000, splitBetween: [adaId, graceId, linusId] });
    const counts = async () => {
      const probe = await openDatabase(database.url);
      try {
        const counted: number[] = [];
        for (const table of ['expenses', 'expense_shares', 'group_members', 'accounts', 'groups', 'sessions']) {
          counted.push((await probe.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n ?? -1);
        }
        return counted;
      } finally {
        await probe.close();
      }
    };
    const before = await counts();
    const first = (await suggested()).body;
    expect((await suggested()).body).toEqual(first);
    expect(await counts()).toEqual(before);
  });
});
