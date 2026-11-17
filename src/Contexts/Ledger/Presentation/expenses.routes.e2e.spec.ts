import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Expenses, over HTTP: recording one split equally between the members of a group, reading it back, and the refusals.
 * Groups are made and joined through the groups' own routes; the answers are held to the API `api/` gives, through
 * `apiClient()`.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-ledger-')), 'tally.sqlite');
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

let accountCount = 0;
/** A signed-in person, with a fresh email, and their token. */
async function signedInPerson(name: string): Promise<{ token: string; id: string }> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const password = 'a long password';
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const { token } = (await http.request('POST', `${api}/accounts/login`, { body: { email, password } })).body as {
    token: string;
  };
  return { token, id: (created.body as { id: string }).id };
}

/** A group owned by `owner`, which each of `others` has joined through an invitation. */
async function groupWith(owner: { token: string }, others: { token: string }[]): Promise<string> {
  const { id } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: owner.token })
  ).body as { id: string };
  for (const person of others) {
    const invitation = (await http.request('POST', `${api}/groups/${id}/invitations`, { token: owner.token })).body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  return id;
}

const record = (groupId: string, body: Record<string, unknown>, token?: string) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const getExpense = (id: string, token?: string) => http.request('GET', `${api}/expenses/${id}`, { token });

/** A day after any day the suite runs on: a date that is not yet, whatever today is. */
const tomorrow = '2999-12-31';

describe('recording an expense', () => {
  it('answers the new expense, and reads it back split equally, the remainder to the payer', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');
    const groupId = await groupWith(ada, [grace, linus]);

    const answer = await record(
      groupId,
      { description: 'Groceries', amount: 1000, date: '2020-01-15', splitBetween: [ada.id, grace.id, linus.id] },
      ada.token,
    );
    expect(answer.status).toBe(201);
    const { id } = answer.body as { id: string };

    const read = await getExpense(id, grace.token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id,
      groupId,
      description: 'Groceries',
      amount: 1000,
      date: '2020-01-15',
      paidBy: ada.id,
      splitKind: 'equal',
      shares: [
        { memberId: ada.id, amount: 334 },
        { memberId: grace.id, amount: 333 },
        { memberId: linus.id, amount: 333 },
      ],
      version: 1,
    });
  });

  it('keeps the order the member gave the split in, and its shares add up to the amount', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');
    const groupId = await groupWith(ada, [grace, linus]);

    const { id } = (
      await record(
        groupId,
        { description: '  Taxi  ', amount: 10, date: '2020-01-15', splitBetween: [grace.id, ada.id, linus.id] },
        ada.token,
      )
    ).body as { id: string };

    const { body } = await getExpense(id, ada.token);
    expect(body).toMatchObject({
      description: 'Taxi',
      shares: [
        { memberId: grace.id, amount: 3 },
        { memberId: ada.id, amount: 4 },
        { memberId: linus.id, amount: 3 },
      ],
    });
  });

  it('refuses a description that is only spaces, or a date that is not a real day or is after today', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    const split = [ada.id];

    expect(
      (await record(groupId, { description: '   ', amount: 5, date: '2020-01-15', splitBetween: split }, ada.token))
        .body,
    ).toEqual({ type: 'InvalidExpenseDescription', message: expect.any(String) });
    expect(
      (await record(groupId, { description: 'Bread', amount: 5, date: '2020-02-30', splitBetween: split }, ada.token))
        .body,
    ).toEqual({ type: 'InvalidExpenseDate', message: expect.any(String) });
    const future = await record(
      groupId,
      { description: 'Bread', amount: 5, date: tomorrow, splitBetween: split },
      ada.token,
    );
    expect(future.status).toBe(400);
    expect(future.body).toEqual({ type: 'InvalidExpenseDate', message: expect.any(String) });
  });

  it('refuses an amount outside 1 to 100 000 000, and an amount that is not a whole number on the wire', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    const body = { description: 'Bread', date: '2020-01-15', splitBetween: [ada.id] };

    for (const amount of [0, 100_000_001]) {
      const answer = await record(groupId, { ...body, amount }, ada.token);
      expect(answer.status).toBe(400);
      expect(answer.body).toEqual({ type: 'InvalidExpenseAmount', message: expect.any(String) });
    }
    const notANumber = await record(groupId, { ...body, amount: '1000' }, ada.token);
    expect(notANumber.status).toBe(400);
  });

  it('refuses a split with someone outside the group, a member listed twice, or without the payer', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const outsider = await signedInPerson('Outsider');
    const groupId = await groupWith(ada, [grace]);
    const body = { description: 'Bread', amount: 900, date: '2020-01-15' };

    const withOutsider = await record(groupId, { ...body, splitBetween: [ada.id, outsider.id] }, ada.token);
    expect(withOutsider.body).toEqual({ type: 'SplitMemberNotInGroup', message: expect.any(String) });

    const twice = await record(groupId, { ...body, splitBetween: [ada.id, grace.id, grace.id] }, ada.token);
    expect(twice.body).toEqual({ type: 'SplitMemberListedTwice', message: expect.any(String) });

    const withoutPayer = await record(groupId, { ...body, splitBetween: [grace.id] }, ada.token);
    expect(withoutPayer.body).toEqual({ type: 'PayerNotInSplit', message: expect.any(String) });
  });

  it('refuses a body of the wrong shape with 400, and a missing caller with 401', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    const body = { description: 'Bread', amount: 5, date: '2020-01-15', splitBetween: [ada.id] };

    const missing = await record(groupId, { ...body, splitBetween: 'me' }, ada.token);
    expect(missing.status).toBe(400);
    expect((await record(groupId, body)).status).toBe(401);
  });

  it('answers a group that does not exist, or one the caller is not in, with 404', async () => {
    const ada = await signedInPerson('Ada');
    const stranger = await signedInPerson('Stranger');
    const groupId = await groupWith(ada, []);
    const body = { description: 'Bread', amount: 5, date: '2020-01-15', splitBetween: [ada.id] };

    expect((await record(groupId, body, stranger.token)).status).toBe(404);
    expect((await record('no-such-group', body, ada.token)).status).toBe(404);
  });
});

describe('reading an expense', () => {
  it('lets a member of its group read it, and answers anyone else as if it did not exist', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const stranger = await signedInPerson('Stranger');
    const groupId = await groupWith(ada, [grace]);
    const { id } = (
      await record(
        groupId,
        { description: 'Gas', amount: 80, date: '2020-01-15', splitBetween: [ada.id, grace.id] },
        ada.token,
      )
    ).body as { id: string };

    expect((await getExpense(id, grace.token)).status).toBe(200);
    expect((await getExpense(id, stranger.token)).status).toBe(404);
    expect((await getExpense('no-such-expense', ada.token)).status).toBe(404);
    expect((await getExpense(id)).status).toBe(401);
  });
});

describe('splitting an expense by exact amounts or by shares (request 7)', () => {
  const edit = (id: string, body: Record<string, unknown>, token?: string) =>
    http.request('PUT', `${api}/expenses/${id}`, { body, token });

  it('records an expense by exact amounts, and reads it back as exact, the shares in the order given', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);

    const answer = await record(
      groupId,
      {
        description: 'Dinner',
        amount: 1000,
        date: '2020-01-15',
        splitExactly: [
          { memberId: grace.id, amount: 700 },
          { memberId: ada.id, amount: 300 },
        ],
      },
      ada.token,
    );
    expect(answer.status).toBe(201);
    const { id } = answer.body as { id: string };

    const { body } = await getExpense(id, grace.token);
    expect(body).toMatchObject({
      amount: 1000,
      paidBy: ada.id,
      splitKind: 'exact',
      shares: [
        { memberId: grace.id, amount: 700 },
        { memberId: ada.id, amount: 300 },
      ],
    });
  });

  it('records an expense by shares, the remainder to the payer, and reads it back as shares', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);

    const { id } = (
      await record(
        groupId,
        {
          description: 'Cottage',
          amount: 1001,
          date: '2020-01-15',
          splitByShares: [
            { memberId: grace.id, shares: 2 },
            { memberId: ada.id, shares: 1 },
          ],
        },
        ada.token,
      )
    ).body as { id: string };

    const { body } = await getExpense(id, ada.token);
    expect(body).toMatchObject({
      splitKind: 'shares',
      shares: [
        { memberId: grace.id, amount: 667 },
        { memberId: ada.id, amount: 334 },
      ],
    });
  });

  it('refuses a body with none of the three splits, or more than one, with 400 of its shape', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    const body = { description: 'Bread', amount: 5, date: '2020-01-15' };

    expect((await record(groupId, body, ada.token)).status).toBe(400);
    const two = await record(
      groupId,
      { ...body, splitBetween: [ada.id], splitByShares: [{ memberId: ada.id, shares: 1 }] },
      ada.token,
    );
    expect(two.status).toBe(400);
    const wrongLine = await record(groupId, { ...body, splitExactly: [{ memberId: ada.id, amount: '5' }] }, ada.token);
    expect(wrongLine.status).toBe(400);
  });

  it('refuses exact amounts that do not add up, a negative one, and shares below one, by name, with 400', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);
    const body = { description: 'Bread', amount: 100, date: '2020-01-15' };

    const short = await record(
      groupId,
      {
        ...body,
        splitExactly: [
          { memberId: ada.id, amount: 60 },
          { memberId: grace.id, amount: 30 },
        ],
      },
      ada.token,
    );
    expect(short.status).toBe(400);
    expect(short.body).toEqual({ type: 'SplitAmountsDoNotAddUp', message: expect.any(String) });

    const negative = await record(
      groupId,
      {
        ...body,
        splitExactly: [
          { memberId: ada.id, amount: 150 },
          { memberId: grace.id, amount: -50 },
        ],
      },
      ada.token,
    );
    expect(negative.body).toEqual({ type: 'InvalidSplitAmount', message: expect.any(String) });

    const noShares = await record(
      groupId,
      {
        ...body,
        splitByShares: [
          { memberId: ada.id, shares: 0 },
          { memberId: grace.id, shares: 1 },
        ],
      },
      ada.token,
    );
    expect(noShares.body).toEqual({ type: 'InvalidSplitShares', message: expect.any(String) });
  });

  it('edits an expense into another split, from the version read, and reads it as that split', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);
    const { id } = (
      await record(
        groupId,
        { description: 'Gas', amount: 100, date: '2020-01-15', splitBetween: [ada.id, grace.id] },
        ada.token,
      )
    ).body as { id: string };

    const answer = await edit(
      id,
      {
        description: 'Gas',
        amount: 100,
        date: '2020-01-15',
        version: 1,
        splitByShares: [
          { memberId: grace.id, shares: 3 },
          { memberId: ada.id, shares: 1 },
        ],
      },
      ada.token,
    );
    expect(answer.status).toBe(204);

    const { body } = await getExpense(id, ada.token);
    expect(body).toMatchObject({
      splitKind: 'shares',
      version: 2,
      shares: [
        { memberId: grace.id, amount: 75 },
        { memberId: ada.id, amount: 25 },
      ],
    });
  });
});
