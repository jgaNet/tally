import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

// The application keeps what it knows in the file DATABASE_PATH names: this suite has a file of its own.
process.env.DATABASE_PATH = join(tmpdir(), `tally-expenses-${randomUUID()}.db`);

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

const record = (token: string | undefined, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const readExpense = (id: string, token?: string) => http.request('GET', `${api}/expenses/${id}`, { token });

describe('recording an expense', () => {
  it('records an expense the caller paid, answering 201 with its id, and reads it back as recorded', async () => {
    const ada = await signedIn('ada@example.com', 'Ada');
    const bob = await signedIn('bob@example.com', 'Bob');
    const cy = await signedIn('cy@example.com', 'Cy');
    const groupId = await groupWith(ada, [bob, cy]);

    const created = await record(ada.token, groupId, {
      description: 'Groceries',
      amount: 1000,
      date: PAST,
      splitBetween: [ada.id, bob.id, cy.id],
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String) });

    const read = await readExpense((created.body as { id: string }).id, ada.token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id: (created.body as { id: string }).id,
      groupId,
      description: 'Groceries',
      amount: 1000,
      date: PAST,
      paidBy: ada.id,
      shares: [
        { memberId: ada.id, amount: 334 },
        { memberId: bob.id, amount: 333 },
        { memberId: cy.id, amount: 333 },
      ],
      version: 1,
    });
  });

  it('keeps the shares in the order the split was given, and the shares add up to the amount', async () => {
    const ada = await signedIn('order-ada@example.com', 'Ada');
    const bob = await signedIn('order-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);

    const created = await record(ada.token, groupId, {
      description: 'Taxi',
      amount: 7,
      date: PAST,
      splitBetween: [bob.id, ada.id],
    });
    const read = await readExpense((created.body as { id: string }).id, ada.token);

    expect((read.body as { shares: unknown }).shares).toEqual([
      { memberId: bob.id, amount: 3 },
      { memberId: ada.id, amount: 4 },
    ]);
  });

  it('refuses a missing caller with 401, before anything is recorded', async () => {
    const ada = await signedIn('anon-ada@example.com', 'Ada');
    const groupId = await groupWith(ada, []);

    expect(
      (await record(undefined, groupId, { description: 'X', amount: 5, date: PAST, splitBetween: [ada.id] })).status,
    ).toBe(401);
  });

  it('answers a group the caller is not a member of as if it did not exist', async () => {
    const ada = await signedIn('owner-ada@example.com', 'Ada');
    const eve = await signedIn('eve@example.com', 'Eve');
    const groupId = await groupWith(ada, []);

    expect(
      await record(eve.token, groupId, { description: 'X', amount: 5, date: PAST, splitBetween: [eve.id] }),
    ).toMatchObject({
      status: 404,
      body: { type: 'NotFound' },
    });
  });

  it('refuses what the domain refuses with 422, named by the rule', async () => {
    const ada = await signedIn('rules-ada@example.com', 'Ada');
    const bob = await signedIn('rules-bob@example.com', 'Bob');
    const eve = await signedIn('rules-eve@example.com', 'Eve');
    const groupId = await groupWith(ada, [bob]);
    const FUTURE = '2999-01-01'; // after today, whenever the suite runs
    const valid = { description: 'Rent', amount: 500, date: PAST, splitBetween: [ada.id, bob.id] };

    const refusals: Array<[unknown, string]> = [
      [{ ...valid, description: '   ' }, 'InvalidDescription'],
      [{ ...valid, amount: 0 }, 'InvalidAmount'],
      [{ ...valid, amount: 100_000_001 }, 'InvalidAmount'],
      [{ ...valid, date: '2026-02-30' }, 'InvalidDate'],
      [{ ...valid, date: FUTURE }, 'InvalidDate'],
      [{ ...valid, splitBetween: [ada.id, ada.id] }, 'DuplicateInSplit'],
      [{ ...valid, splitBetween: [ada.id, eve.id] }, 'NotAMemberInSplit'],
      [{ ...valid, splitBetween: [bob.id] }, 'PayerNotInSplit'],
    ];
    for (const [body, type] of refusals) {
      expect(await record(ada.token, groupId, body)).toMatchObject({ status: 422, body: { type } });
    }
  });

  it('refuses a body of the wrong shape with 400', async () => {
    const ada = await signedIn('shape-ada@example.com', 'Ada');
    const groupId = await groupWith(ada, []);

    expect(
      (await record(ada.token, groupId, { description: 'Rent', amount: 'ten', date: PAST, splitBetween: [ada.id] }))
        .status,
    ).toBe(400);
    expect((await record(ada.token, groupId, { description: 'Rent', amount: 5, date: PAST })).status).toBe(400);
  });
});

describe('reading an expense', () => {
  it('answers 404 to anyone who is not a member of its group, and to a missing expense', async () => {
    const ada = await signedIn('read-ada@example.com', 'Ada');
    const eve = await signedIn('read-eve@example.com', 'Eve');
    const groupId = await groupWith(ada, []);
    const created = await record(ada.token, groupId, {
      description: 'Rent',
      amount: 5,
      date: PAST,
      splitBetween: [ada.id],
    });
    const id = (created.body as { id: string }).id;

    expect(await readExpense(id, eve.token)).toMatchObject({ status: 404, body: { type: 'NotFound' } });
    expect(await readExpense(id)).toMatchObject({ status: 401 });
    expect(await readExpense(randomUUID(), ada.token)).toMatchObject({ status: 404 });
  });
});

describe('editing and deleting an expense', () => {
  const edit = (id: string, token: string | undefined, body: unknown) =>
    http.request('PUT', `${api}/expenses/${id}`, { body, token });
  const remove = (id: string, token: string | undefined) => http.request('DELETE', `${api}/expenses/${id}`, { token });
  const balances = (groupId: string, token: string) =>
    http.request('GET', `${api}/groups/${groupId}/balances`, { token });

  /** Ada owns the group, Bob and Cy are members; Bob paid 900 for Ada, Bob and Cy, and the version it is recorded at is 1. */
  async function recordedByBob() {
    const tag = randomUUID();
    const ada = await signedIn(`edit-ada-${tag}@example.com`, 'Ada');
    const bob = await signedIn(`edit-bob-${tag}@example.com`, 'Bob');
    const cy = await signedIn(`edit-cy-${tag}@example.com`, 'Cy');
    const groupId = await groupWith(ada, [bob, cy]);
    const created = await record(bob.token, groupId, {
      description: 'Groceries',
      amount: 900,
      date: PAST,
      splitBetween: [bob.id, ada.id, cy.id],
    });
    const id = (created.body as { id: string }).id;
    return { ada, bob, cy, groupId, id };
  }

  it('gives the expense again, whole, from the version its author read: 204, and the expense reads at the next version', async () => {
    const { ada, bob, id } = await recordedByBob();
    expect((await readExpense(id, bob.token)).body).toMatchObject({ version: 1 });

    const answer = await edit(id, bob.token, {
      description: 'Groceries and wine',
      amount: 1000,
      date: PAST,
      splitBetween: [bob.id, ada.id],
      version: 1,
    });
    expect(answer.status).toBe(204);

    expect((await readExpense(id, ada.token)).body).toMatchObject({
      description: 'Groceries and wine',
      amount: 1000,
      paidBy: bob.id,
      version: 2,
      shares: [
        { memberId: bob.id, amount: 500 },
        { memberId: ada.id, amount: 500 },
      ],
    });
  });

  it('lets the group owner edit an expense another member paid, and the payer stays the one who paid', async () => {
    const { ada, bob, id } = await recordedByBob();

    const answer = await edit(id, ada.token, {
      description: 'Groceries',
      amount: 900,
      date: PAST,
      splitBetween: [bob.id, ada.id],
      version: 1,
    });
    expect(answer.status).toBe(204);
    expect((await readExpense(id, ada.token)).body).toMatchObject({ paidBy: bob.id, version: 2 });
  });

  it('refuses an edit by a member who is neither the payer nor the owner, and does not change the expense', async () => {
    const { cy, bob, id } = await recordedByBob();

    const answer = await edit(id, cy.token, {
      description: 'Mine now',
      amount: 1,
      date: PAST,
      splitBetween: [cy.id],
      version: 1,
    });
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual({ type: 'NotAllowed', message: expect.any(String) });
    expect((await readExpense(id, bob.token)).body).toMatchObject({ description: 'Groceries', version: 1 });
  });

  it('refuses an edit made from a version the expense has moved past, by name, and keeps nothing of it', async () => {
    const { ada, bob, id } = await recordedByBob();
    await edit(id, bob.token, {
      description: 'First',
      amount: 900,
      date: PAST,
      splitBetween: [bob.id, ada.id],
      version: 1,
    });

    const stale = await edit(id, bob.token, {
      description: 'Stale',
      amount: 300,
      date: PAST,
      splitBetween: [bob.id],
      version: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ type: 'ExpenseChanged', message: expect.any(String) });
    expect((await readExpense(id, ada.token)).body).toMatchObject({ description: 'First', amount: 900, version: 2 });
  });

  it('keeps one of two edits made at once from the same version, refuses the other, and the balances still add up to 0', async () => {
    const { ada, bob, cy, groupId, id } = await recordedByBob();

    const [first, second] = await Promise.all([
      edit(id, bob.token, { description: 'Bob', amount: 900, date: PAST, splitBetween: [bob.id, ada.id], version: 1 }),
      edit(id, ada.token, { description: 'Ada', amount: 900, date: PAST, splitBetween: [ada.id, cy.id], version: 1 }),
    ]);

    expect([first.status, second.status].sort()).toEqual([204, 409]);
    const refused = first.status === 409 ? first : second;
    expect(refused.body).toEqual({ type: 'ExpenseChanged', message: expect.any(String) });
    const kept = (await readExpense(id, bob.token)).body as { description: string; version: number; shares: unknown[] };
    expect(kept.version).toBe(2);
    expect(['Bob', 'Ada']).toContain(kept.description);

    const sum = ((await balances(groupId, bob.token)).body as Array<{ balance: number }>).reduce(
      (total, member) => total + member.balance,
      0,
    );
    expect(sum).toBe(0);
  });

  it('deletes the expense for its payer or the owner: it is gone from every read and counts in no balance', async () => {
    const { ada, bob, cy, groupId, id } = await recordedByBob();

    expect(await remove(id, cy.token)).toMatchObject({ status: 403 });
    expect(await remove(id, ada.token)).toMatchObject({ status: 204 });

    expect(await readExpense(id, bob.token)).toMatchObject({ status: 404 });
    expect((await balances(groupId, bob.token)).body).toEqual([
      { memberId: ada.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
      { memberId: cy.id, balance: 0 },
    ]);
  });

  it('answers the same refusals to anyone outside the group as for an expense that does not exist', async () => {
    const { id } = await recordedByBob();
    const outsider = await signedIn(`edit-out-${randomUUID()}@example.com`, 'Out');

    expect(
      await edit(id, outsider.token, {
        description: 'x',
        amount: 1,
        date: PAST,
        splitBetween: [outsider.id],
        version: 1,
      }),
    ).toMatchObject({ status: 404 });
    expect(await remove(id, outsider.token)).toMatchObject({ status: 404 });
    expect(await remove(randomUUID(), outsider.token)).toMatchObject({ status: 404 });
  });

  it('refuses an edit whose split leaves the payer out (422) and a body without its version (400)', async () => {
    const { ada, bob, id } = await recordedByBob();

    const leftOut = await edit(id, bob.token, {
      description: 'x',
      amount: 900,
      date: PAST,
      splitBetween: [ada.id],
      version: 1,
    });
    expect(leftOut).toMatchObject({ status: 422, body: { type: 'PayerNotInSplit' } });

    const noVersion = await edit(id, bob.token, { description: 'x', amount: 900, date: PAST, splitBetween: [bob.id] });
    expect(noVersion.status).toBe(400);
  });
});

describe('Groups → Ledger', () => {
  it('records an expense in the group Groups made, by the id its creation answered, and reads it back in that group', async () => {
    const ada = await signedIn('gl-ada@example.com', 'Ada');
    const bob = await signedIn('gl-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);

    // Bob has just joined: he may be in a split at once, from the membership Groups committed (T3, ADR 4).
    const created = await record(bob.token, groupId, {
      description: 'Dinner',
      amount: 90,
      date: PAST,
      splitBetween: [bob.id, ada.id],
    });
    expect(created.status).toBe(201);

    const read = await readExpense((created.body as { id: string }).id, ada.token);
    expect(read.body).toMatchObject({
      groupId,
      paidBy: bob.id,
      shares: [
        { memberId: bob.id, amount: 45 },
        { memberId: ada.id, amount: 45 },
      ],
    });
  });
});
