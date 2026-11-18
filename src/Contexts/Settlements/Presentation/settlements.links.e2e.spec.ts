import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The relationships request 12 carries, over HTTP (ADR 10): each thing is made in one context through the API, its id is the one
 * that request answered, and the other context finds it by that same id, or counts it in what it reads. Each relationship of the
 * context map is named by its title, so that the gate can see the test that holds it.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const PAST_DAY = '2020-01-15';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-settlement-links-'));
  // No payment provider here: paying through one is refused for want of a link, and nothing is kept (request 13).
  app = await createApplication({ databaseUrl: await freshDatabase(), logger: silent, providerUrl: '' });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
  eve = await person('Eve', 'eve@example.com');
});
afterAll(async () => {
  await app.stop();
  rmSync(directory, { recursive: true, force: true });
});

/** A signed-in person: their token, and their account id as the account answers it. */
async function person(name: string, email: string) {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id, name };
}

let ann: Awaited<ReturnType<typeof person>>;
let bob: Awaited<ReturnType<typeof person>>;
let eve: Awaited<ReturnType<typeof person>>;

/** A group made in Groups: the id the creation answered, and Bob joined through an invitation. */
const groupWithBob = async () => {
  const created = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: 'Trip', currency: 'EUR' },
  });
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: bob.token,
  });
  return groupId;
};

/**
 * Two people of their own, that no other test of this file shares a group with, so that a netting in a test is over the groups the test
 * made, and no other (a netting spans every group the two share).
 */
async function strangers(tag: string) {
  const first = await person('Xia', `xia-${tag}@example.com`);
  const second = await person('Yan', `yan-${tag}@example.com`);
  return { first, second };
}

/** A group made by `owner` in EUR, with `other` in it through an invitation. */
async function groupOf(owner: { token: string }, other: { token: string }, name: string) {
  const created = await http.request('POST', `${api}/groups`, { token: owner.token, body: { name, currency: 'EUR' } });
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: other.token,
  });
  return groupId;
}

describe('Groups → Settlements (SettlementMembers)', () => {
  it('the settlements of the group Groups made are listed by the id its creation answered, each with its history (request 19)', async () => {
    const groupId = await groupWithBob();
    const paid = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Dinner', amount: 1000, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });
    expect(paid.status).toBe(201);
    const settled = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 500 },
    });
    const settlementId = (settled.body as { id: string }).id;

    // Bob, a member Groups made, lists the group by the id its creation answered: the settlement is there, paid once.
    const listed = await http.request('GET', `${api}/groups/${groupId}/settlements`, { token: bob.token });
    expect(listed.status).toBe(200);
    const [only] = listed.body as { id: string; groupId: string; history: { status: string }[] }[];
    expect(listed.body as unknown[]).toHaveLength(1);
    expect(only).toMatchObject({ id: settlementId, groupId, history: [{ status: 'paid' }] });

    // Eve is not in the group Groups made: to her it does not exist.
    expect((await http.request('GET', `${api}/groups/${groupId}/settlements`, { token: eve.token })).status).toBe(404);
  });

  it('a settlement is recorded in the group Groups made, by the id its creation answered, and is read back with that group', async () => {
    const groupId = await groupWithBob();

    const recorded = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: bob.token,
      body: { from: ann.id, amount: 100 },
    });
    // Ann owes nothing yet, so a settlement from her to Bob is more than she owes: refused, the group is Groups' made.
    expect(recorded.status).toBe(422);

    const owed = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Dinner', amount: 1000, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });
    expect(owed.status).toBe(201);

    const paid = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 500 },
    });
    expect(paid.status).toBe(201);
    const settlementId = (paid.body as { id: string }).id;

    const read = await http.request('GET', `${api}/settlements/${settlementId}`, { token: bob.token });
    expect((read.body as { groupId: string }).groupId).toBe(groupId);

    // Eve is signed in but not in this group: Settlements' roster of its members refuses her with the group's 404.
    const outsider = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: eve.token,
      body: { from: bob.id, amount: 100 },
    });
    expect(outsider.status).toBe(404);
  });

  it('a payment through the provider is asked in the group Groups made, found by the id its creation answered, and not for a stranger', async () => {
    const groupId = await groupWithBob();
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Lunch', amount: 1000, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });

    // No provider is configured in this application: Ann cannot have set a payout account the provider must confirm (request 16), so
    // Settlements finds the group and its members, checks the rules and the payee's account, and refuses the payment by name before
    // anything is asked, keeping nothing.
    const asked = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      token: bob.token,
      body: { to: ann.id, amount: 500 },
    });
    expect(asked.status).toBe(422);
    expect(asked.body).toEqual({ type: 'PayeeHasNoPayoutAccount', message: expect.any(String) });

    // Eve is not in this group: the same 404 as for a group that does not exist.
    const outsider = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      token: eve.token,
      body: { to: ann.id, amount: 100 },
    });
    expect(outsider.status).toBe(404);
  });

  it('a refund is asked in the group Groups made, for a settlement found by the id its recording answered, and not for a stranger', async () => {
    const groupId = await groupWithBob();
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Snacks', amount: 1000, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });
    const recorded = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 500 },
    });
    expect(recorded.status).toBe(201);
    const settlementId = (recorded.body as { id: string }).id;

    // Eve is not in this group: the same 404 as for a settlement that does not exist, from Settlements' roster of its members.
    const outsider = await http.request('POST', `${api}/settlements/${settlementId}/refund`, { token: eve.token });
    expect(outsider.status).toBe(404);

    // Bob is a member and the payer, not the payee: refused as not allowed; and the cash settlement is not refunded through Tally.
    const byPayer = await http.request('POST', `${api}/settlements/${settlementId}/refund`, { token: bob.token });
    expect(byPayer.status).toBe(403);
    const inCash = await http.request('POST', `${api}/settlements/${settlementId}/refund`, { token: ann.token });
    expect(inCash.status).toBe(422);
    expect(inCash.body).toEqual({ type: 'SettlementNotRefundable', message: expect.any(String) });
  });

  it('a netting finds the groups two members share through the roster, by the ids Groups answered, and nets in them', async () => {
    const { first, second } = await strangers('groups');
    const flat = await groupOf(first, second, 'Flat');
    await http.request('POST', `${api}/groups/${flat}/expenses`, {
      token: second.token,
      body: { description: 'Flat', amount: 600, date: PAST_DAY, splitBetween: [first.id, second.id] },
    });
    // Yan owes Xia 400 in a club, so there is a debt each way to net.
    const club = await groupOf(first, second, 'Club');
    await http.request('POST', `${api}/groups/${club}/expenses`, {
      token: first.token,
      body: { description: 'Club', amount: 800, date: PAST_DAY, splitBetween: [first.id, second.id] },
    });
    const made = await http.request('POST', `${api}/nettings`, {
      token: first.token,
      body: { with: second.id, currency: 'EUR' },
    });
    expect(made.status).toBe(201);
    const netting = (
      await http.request('GET', `${api}/nettings/${(made.body as { id: string }).id}`, { token: first.token })
    ).body as { amount: number; settlements: string[] };
    expect(netting.amount).toBe(300);
    // The settlement is in the group Groups made, found by the id its creation answered.
    const settled = (await http.request('GET', `${api}/settlements/${netting.settlements[0]}`, { token: second.token }))
      .body as {
      groupId: string;
    };
    expect(settled.groupId).toBe(flat);

    // Eve is no member of this group: nothing to net with her.
    expect(
      (await http.request('POST', `${api}/nettings`, { token: first.token, body: { with: eve.id, currency: 'EUR' } }))
        .status,
    ).toBe(422);
  });
});

describe('Ledger → Settlements (GroupBalances)', () => {
  it('a settlement is decided against the balance the expense made in Ledger, and finds that expense by its own id', async () => {
    const groupId = await groupWithBob();
    const expense = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Hotel', amount: 1000, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });
    const expenseId = (expense.body as { id: string }).id;

    // Bob owes 500 because of that expense: 501 is more than he owes, 500 is what he owes.
    const more = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 501 },
    });
    expect(more.body).toMatchObject({ type: 'MoreThanPayerOwes' });

    const exact = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 500 },
    });
    expect(exact.status).toBe(201);

    const found = await http.request('GET', `${api}/expenses/${expenseId}`, { token: ann.token });
    expect((found.body as { id: string }).id).toBe(expenseId);
  });

  it('a payment through the provider is refused by the balance Ledger made, before any provider is asked, and finds that expense by its id', async () => {
    const groupId = await groupWithBob();
    const expense = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Museum', amount: 1000, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });
    const expenseId = (expense.body as { id: string }).id;

    // Bob owes 500 because of that expense: 501 is more than he owes, and the provider is not asked for it.
    const more = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      token: bob.token,
      body: { to: ann.id, amount: 501 },
    });
    expect(more.status).toBe(422);
    expect(more.body).toMatchObject({ type: 'MoreThanPayerOwes' });

    const found = await http.request('GET', `${api}/expenses/${expenseId}`, { token: ann.token });
    expect((found.body as { id: string }).id).toBe(expenseId);
  });

  it('a refund is refused in Settlements for a settlement decided against the balance of an expense Ledger made, and that expense is found by its id', async () => {
    const groupId = await groupWithBob();
    const expense = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Parking', amount: 1000, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });
    const expenseId = (expense.body as { id: string }).id;
    const recorded = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 500 },
    });
    const settlementId = (recorded.body as { id: string }).id;

    // The settlement is decided in Settlements against Ledger's balance, and it is a cash one: its refund is refused for that, and nothing
    // of the expense changes.
    const refused = await http.request('POST', `${api}/settlements/${settlementId}/refund`, { token: ann.token });
    expect(refused.status).toBe(422);
    expect(refused.body).toEqual({ type: 'SettlementNotRefundable', message: expect.any(String) });

    const found = await http.request('GET', `${api}/expenses/${expenseId}`, { token: ann.token });
    expect((found.body as { id: string }).id).toBe(expenseId);
  });

  it("a netting nets only what Ledger counts as still owed in each group, and the balances afterwards are the ledger's", async () => {
    const { first, second } = await strangers('ledger');
    const flat = await groupOf(first, second, 'Flat');
    await http.request('POST', `${api}/groups/${flat}/expenses`, {
      token: second.token,
      body: { description: 'Flat', amount: 600, date: PAST_DAY, splitBetween: [first.id, second.id] },
    });
    const trip = await groupOf(first, second, 'Trip');
    await http.request('POST', `${api}/groups/${trip}/expenses`, {
      token: first.token,
      body: { description: 'Trip', amount: 800, date: PAST_DAY, splitBetween: [first.id, second.id] },
    });
    // Xia owes Yan 300 in the flat; Yan owes Xia 400 in the trip: 300 is netted, and Xia is still owed 100 in the trip.
    const made = await http.request('POST', `${api}/nettings`, {
      token: first.token,
      body: { with: second.id, currency: 'EUR' },
    });
    expect(made.status).toBe(201);
    const balances = (await http.request('GET', `${api}/groups/${trip}/balances`, { token: first.token })).body as {
      memberId: string;
      balance: number;
    }[];
    expect(balances).toContainEqual({ memberId: first.id, balance: 100 });
    expect(balances).toContainEqual({ memberId: second.id, balance: -100 });
  });
});

describe('Settlements → Ledger (SettledAmounts)', () => {
  it('a settlement made in Settlements, found by its own id, is counted by the balances Ledger reads and by the statement (request 29)', async () => {
    const groupId = await groupWithBob();
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token: ann.token,
      body: { description: 'Taxi', amount: 1000, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });

    const recorded = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 300 },
    });
    const settlementId = (recorded.body as { id: string }).id;
    const read = await http.request('GET', `${api}/settlements/${settlementId}`, { token: ann.token });
    expect((read.body as { amount: number }).amount).toBe(300);

    const balances = await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ann.token });
    expect(balances.body).toEqual([
      { memberId: ann.id, balance: 200 },
      { memberId: bob.id, balance: -200 },
    ]);

    const statement = await http.request('GET', `${api}/groups/${groupId}/members/${bob.id}/statement`, {
      token: ann.token,
    });
    expect((statement.body as { balance: number }).balance).toBe(-200);
  });

  it('a netting counts in the balances and the statement Ledger reads, named as a settlement by netting', async () => {
    const { first, second } = await strangers('statement');
    const flat = await groupOf(first, second, 'Flat');
    await http.request('POST', `${api}/groups/${flat}/expenses`, {
      token: second.token,
      body: { description: 'Flat', amount: 600, date: PAST_DAY, splitBetween: [first.id, second.id] },
    });
    // Yan owes Xia 400 in a club, so there is a debt each way to net.
    const club = await groupOf(first, second, 'Club');
    await http.request('POST', `${api}/groups/${club}/expenses`, {
      token: first.token,
      body: { description: 'Club', amount: 800, date: PAST_DAY, splitBetween: [first.id, second.id] },
    });
    expect(
      (
        await http.request('POST', `${api}/nettings`, {
          token: first.token,
          body: { with: second.id, currency: 'EUR' },
        })
      ).status,
    ).toBe(201);

    const statement = (
      await http.request('GET', `${api}/groups/${flat}/members/${second.id}/statement`, { token: second.token })
    ).body as { balance: number; entries: { kind: string; description: string; paid: number }[] };
    expect(statement.balance).toBe(0);
    expect(statement.entries).toContainEqual(
      expect.objectContaining({ kind: 'settlement', description: 'Settlement by netting', paid: 0 }),
    );
  });
});
