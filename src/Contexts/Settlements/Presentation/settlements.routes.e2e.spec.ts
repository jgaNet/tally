import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

// The application keeps what it knows in the file DATABASE_PATH names: this suite has a file of its own.
process.env.DATABASE_PATH = join(tmpdir(), `tally-settlements-${randomUUID()}.db`);

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

const PASSWORD = 'a-good-password';
const PAST = '2026-01-15';

/** Signs up and signs in a fresh account, answering its token and its id. */
async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

/** A group with its owner as first member, and each given account joined by an invitation, in that order. */
async function groupWith(owner: { token: string }, joiners: Array<{ token: string }>): Promise<string> {
  const group = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (group.body as { id: string }).id;
  for (const joiner of joiners) {
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: joiner.token,
    });
  }
  return groupId;
}

const record = (token: string, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const suggest = (groupId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/settlements/suggested`, { token });
const readBalances = (groupId: string, token: string) =>
  http.request('GET', `${api}/groups/${groupId}/balances`, { token });

describe("a group's suggested settlements", () => {
  it('answers the transfers of request 11 example, in the order made, from the balances as they are', async () => {
    const ann = await signedIn('set-ann@example.com', 'Ann');
    const bob = await signedIn('set-bob@example.com', 'Bob');
    const cy = await signedIn('set-cy@example.com', 'Cy');
    const dan = await signedIn('set-dan@example.com', 'Dan');
    const groupId = await groupWith(ann, [bob, cy, dan]);

    // Ann paid 1000 split exactly: 500 for Ann, 200 for Cy, 300 for Dan. Bob paid 200 for Bob and Cy: 100 each.
    expect(
      (
        await record(ann.token, groupId, {
          description: 'Dinner',
          amount: 1000,
          date: PAST,
          splitExactly: [
            { memberId: ann.id, amount: 500 },
            { memberId: cy.id, amount: 200 },
            { memberId: dan.id, amount: 300 },
          ],
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await record(bob.token, groupId, {
          description: 'Taxi',
          amount: 200,
          date: PAST,
          splitExactly: [
            { memberId: bob.id, amount: 100 },
            { memberId: cy.id, amount: 100 },
          ],
        })
      ).status,
    ).toBe(201);

    const before = await readBalances(groupId, ann.token);
    expect(before.body).toEqual([
      { memberId: ann.id, balance: 500 },
      { memberId: bob.id, balance: 100 },
      { memberId: cy.id, balance: -300 },
      { memberId: dan.id, balance: -300 },
    ]);

    const read = await suggest(groupId, dan.token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual([
      { from: cy.id, to: ann.id, amount: 300 },
      { from: dan.id, to: ann.id, amount: 200 },
      { from: dan.id, to: bob.id, amount: 100 },
    ]);

    // Reading changes nothing: the balances are what the expenses make them.
    expect((await readBalances(groupId, ann.token)).body).toEqual(before.body);
  });

  it('is the same for every member, and empty when every balance is 0', async () => {
    const ada = await signedIn('set-ada@example.com', 'Ada');
    const bea = await signedIn('set-bea@example.com', 'Bea');
    const groupId = await groupWith(ada, [bea]);

    expect((await suggest(groupId, ada.token)).body).toEqual([]);
    expect((await suggest(groupId, bea.token)).body).toEqual([]);
  });

  it('is refused without a caller, and for anyone outside the group the group does not exist', async () => {
    const owner = await signedIn('set-owner@example.com', 'Owner');
    const stranger = await signedIn('set-stranger@example.com', 'Stranger');
    const groupId = await groupWith(owner, []);

    expect((await suggest(groupId)).status).toBe(401);
    expect((await suggest(groupId, stranger.token)).status).toBe(404);
  });
});

describe('Groups → Settlements', () => {
  it('finds a member Groups made by the id its sign-up answered, in the transfers of the group it joined', async () => {
    const ann = await signedIn('gs-ann@example.com', 'Ann');
    const bob = await signedIn('gs-bob@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);
    expect(
      (
        await record(bob.token, groupId, {
          description: 'Dinner',
          amount: 90,
          date: PAST,
          splitBetween: [bob.id, ann.id],
        })
      ).status,
    ).toBe(201);

    // Bob paid 90 split equally with Ann: Ann owes Bob 45, and Bob is found by the id its sign-up answered.
    const read = await suggest(groupId, ann.token);
    expect(read.body).toEqual([{ from: ann.id, to: bob.id, amount: 45 }]);
    expect(
      (read.body as Array<{ from: string; to: string }>).filter(t => t.from === bob.id || t.to === bob.id),
    ).toHaveLength(1);
  });
});

describe('Ledger → Settlements', () => {
  it('reads the transfers of an expense Ledger recorded, by the id the recording answered, in the members that expense split between', async () => {
    const ada = await signedIn('ls-ada@example.com', 'Ada');
    const bob = await signedIn('ls-bob@example.com', 'Bob');
    const cy = await signedIn('ls-cy@example.com', 'Cy');
    const groupId = await groupWith(ada, [bob, cy]);

    const recorded = await record(ada.token, groupId, {
      description: 'Hotel',
      amount: 900,
      date: PAST,
      splitBetween: [ada.id, bob.id, cy.id],
    });
    expect(recorded.status).toBe(201);
    const expenseId = (recorded.body as { id: string }).id;

    // The expense Ledger recorded is the one the id answers: its split is what the suggestion is made of.
    const expense = await http.request('GET', `${api}/expenses/${expenseId}`, { token: ada.token });
    const split = (expense.body as { shares: Array<{ memberId: string; amount: number }> }).shares;
    const splitMembers = new Set(split.map(({ memberId }) => memberId));
    expect(splitMembers).toEqual(new Set([ada.id, bob.id, cy.id]));

    // Ada paid 900 for three: Bob and Cy owe Ada 300 each, found in the transfers of the expense's members.
    const read = await suggest(groupId, bob.token);
    expect(read.body).toEqual([
      { from: bob.id, to: ada.id, amount: 300 },
      { from: cy.id, to: ada.id, amount: 300 },
    ]);
    for (const { from, to } of read.body as Array<{ from: string; to: string }>) {
      expect(splitMembers.has(from) && splitMembers.has(to)).toBe(true);
    }
  });
});

const settle = (token: string, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/settlements/cash`, { body, token });
const readSettlement = (id: string, token?: string) => http.request('GET', `${api}/settlements/${id}`, { token });
const leave = (token: string, groupId: string) => http.request('POST', `${api}/groups/${groupId}/leave`, { token });

describe('a settlement in cash', () => {
  /** Ann paid 60 split equally with Bob: Ann is owed 30, Bob owes 30. Cy is in the group and owes nothing. */
  async function settledUpFrom(): Promise<{
    ann: { token: string; id: string };
    bob: { token: string; id: string };
    cy: { token: string; id: string };
    cyOutside: { token: string };
    groupId: string;
  }> {
    const tag = randomUUID();
    const ann = await signedIn(`cash-ann-${tag}@example.com`, 'Ann');
    const bob = await signedIn(`cash-bob-${tag}@example.com`, 'Bob');
    const cy = await signedIn(`cash-cy-${tag}@example.com`, 'Cy');
    const cyOutside = await signedIn(`cash-out-${tag}@example.com`, 'Out');
    const groupId = await groupWith(ann, [bob, cy]);
    await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 60,
      date: PAST,
      splitBetween: [ann.id, bob.id],
    });
    return { ann, bob, cy, cyOutside, groupId };
  }

  it('is recorded by its payee, counted by the balances at once, and leaves them even', async () => {
    const { ann, bob, groupId } = await settledUpFrom();

    const recorded = await settle(ann.token, groupId, { from: bob.id, amount: 30 });
    expect(recorded.status).toBe(201);
    const id = (recorded.body as { id: string }).id;

    const balances = await readBalances(groupId, ann.token);
    expect(balances.body).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
      { memberId: expect.any(String), balance: 0 },
    ]);

    const read = await readSettlement(id, ann.token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id,
      groupId,
      from: bob.id,
      to: ann.id,
      amount: 30,
      method: 'cash',
      status: 'paid',
      at: expect.any(String),
      // A cash settlement is paid the moment it is recorded: its one status is its history (request 19).
      history: [{ status: 'paid', at: expect.any(String) }],
    });
  });

  it('is read by the members of its group only: anyone else does not find it', async () => {
    const { ann, bob, cy, cyOutside, groupId } = await settledUpFrom();
    const id = (await settle(ann.token, groupId, { from: bob.id, amount: 10 })).body as { id: string };

    expect((await readSettlement(id.id, cy.token)).status).toBe(200);
    expect((await readSettlement(id.id, cyOutside.token)).status).toBe(404);
    expect((await readSettlement(id.id)).status).toBe(401);
  });

  it('is refused when it is more than the payer owes, and nothing changes', async () => {
    const { ann, bob, groupId } = await settledUpFrom();

    const refused = await settle(ann.token, groupId, { from: bob.id, amount: 31 });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ type: 'SettlementExceedsDebt' });
    expect((await readBalances(groupId, ann.token)).body).toEqual([
      { memberId: ann.id, balance: 30 },
      { memberId: bob.id, balance: -30 },
      { memberId: expect.any(String), balance: 0 },
    ]);
  });

  it('is refused when it is not a whole amount of at least 1, or not a member, or a member paying itself', async () => {
    const { ann, bob, cyOutside, groupId } = await settledUpFrom();

    expect((await settle(ann.token, groupId, { from: bob.id, amount: 0 })).status).toBe(422);
    expect((await settle(ann.token, groupId, { from: bob.id, amount: 1.5 })).status).toBe(400);
    expect((await settle(ann.token, groupId, { from: cyOutside.token, amount: 5 })).status).toBe(404);
    expect((await settle(ann.token, groupId, { from: ann.id, amount: 5 })).status).toBe(422);
    expect((await settle(ann.token, groupId, { amount: 5 })).status).toBe(400);
  });

  it('is refused to a caller who is not signed in, and to one who is not a member of the group', async () => {
    const { bob, cyOutside, groupId } = await settledUpFrom();
    expect((await settle(bob.token, groupId, { from: bob.id, amount: 5 })).status).toBe(422);
    expect((await settle(cyOutside.token, groupId, { from: bob.id, amount: 5 })).status).toBe(404);
    expect(
      (await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, { body: { from: bob.id, amount: 5 } }))
        .status,
    ).toBe(401);
  });

  it('decides two at once on the balances as the other left them: one is kept, the other refused', async () => {
    const { ann, bob, groupId } = await settledUpFrom();

    const [first, second] = await Promise.all([
      settle(ann.token, groupId, { from: bob.id, amount: 30 }),
      settle(ann.token, groupId, { from: bob.id, amount: 30 }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 422]);
    expect((await readBalances(groupId, ann.token)).body).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
      { memberId: expect.any(String), balance: 0 },
    ]);
  });

  it('is counted by the suggestions, and not by the statement, which lists expenses only; settled, Bob leaves even', async () => {
    const { ann, bob, groupId } = await settledUpFrom();
    expect((await suggest(groupId, ann.token)).body).toEqual([{ from: bob.id, to: ann.id, amount: 30 }]);

    await settle(ann.token, groupId, { from: bob.id, amount: 30 });

    expect((await suggest(groupId, ann.token)).body).toEqual([]);
    expect((await leave(bob.token, groupId)).status).toBe(204);
    const statement = await http.request('GET', `${api}/groups/${groupId}/members/${bob.id}/statement`, {
      token: ann.token,
    });
    expect((statement.body as { balance: number }).balance).toBe(-30);
  });
});

describe('Settlements → Ledger', () => {
  it('counts the settlement the recording answered, by its id, in the balances Ledger reads through the API, at once', async () => {
    const tag = randomUUID();
    const ann = await signedIn(`sl-ann-${tag}@example.com`, 'Ann');
    const bob = await signedIn(`sl-bob-${tag}@example.com`, 'Bob');
    const groupId = await groupWith(ann, [bob]);
    await record(ann.token, groupId, { description: 'Dinner', amount: 60, date: PAST, splitBetween: [ann.id, bob.id] });

    // Ledger's balances before: Ann is owed 30, Bob owes 30.
    const before = (await readBalances(groupId, ann.token)).body as Array<{ memberId: string; balance: number }>;
    expect(before).toEqual([
      { memberId: ann.id, balance: 30 },
      { memberId: bob.id, balance: -30 },
    ]);

    // Ann records the 30 Bob paid her: the id the request answered is the settlement's, and it is read by that id.
    const recorded = await settle(ann.token, groupId, { from: bob.id, amount: 30 });
    expect(recorded.status).toBe(201);
    const settlementId = (recorded.body as { id: string }).id;
    const settlement = await readSettlement(settlementId, ann.token);
    expect(settlement.body).toMatchObject({ id: settlementId, from: bob.id, to: ann.id, amount: 30 });

    // Ledger's balances after: each moved by exactly that settlement's amount, the payer up and the payee down.
    const after = (await readBalances(groupId, ann.token)).body as Array<{ memberId: string; balance: number }>;
    expect(after).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);
  });
});
