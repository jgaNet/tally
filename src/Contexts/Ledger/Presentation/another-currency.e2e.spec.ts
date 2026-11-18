import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * An expense paid in another currency, over HTTP (request 21): recorded at the rate its payer states, read back with its original,
 * counted and split in the group's currency, edited either way, and refused by name. Groups are made and joined through the groups'
 * own routes (EUR); the answers are held to the API `api/` gives, through `apiClient()`.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-another-currency-')), 'tally.sqlite');
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

/** A EUR group owned by `owner`, which each of `others` has joined through an invitation. */
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
const edit = (id: string, body: Record<string, unknown>, token?: string) =>
  http.request('PUT', `${api}/expenses/${id}`, { body, token });
const getExpense = (id: string, token?: string) => http.request('GET', `${api}/expenses/${id}`, { token });

describe('recording an expense in another currency', () => {
  it('answers the new expense, and reads it back with its original, the rate as given, and its amount in the group currency', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);

    const answer = await record(
      groupId,
      {
        description: 'Zurich dinner',
        original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
        date: '2020-01-15',
        splitBetween: [ada.id, grace.id],
      },
      ada.token,
    );
    expect(answer.status).toBe(201);
    const { id } = answer.body as { id: string };

    const read = await getExpense(id, grace.token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id,
      groupId,
      description: 'Zurich dinner',
      amount: 1311,
      original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
      date: '2020-01-15',
      paidBy: ada.id,
      splitKind: 'equal',
      category: 'other',
      shares: [
        { memberId: ada.id, amount: 656 },
        { memberId: grace.id, amount: 655 },
      ],
      version: 1,
    });
  });

  it('rounds a half up, and keeps a rate of a whole number as the string it was given', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);

    const { id } = (
      await record(
        groupId,
        {
          description: 'Coffee',
          original: { currency: 'USD', amount: 1000, rate: '0.9545' },
          date: '2020-01-15',
          splitBetween: [ada.id],
        },
        ada.token,
      )
    ).body as { id: string };
    expect((await getExpense(id, ada.token)).body).toMatchObject({ amount: 955, original: { rate: '0.9545' } });

    const { id: whole } = (
      await record(
        groupId,
        {
          description: 'Tram',
          original: { currency: 'GBP', amount: 7, rate: '1' },
          date: '2020-01-15',
          splitBetween: [ada.id],
        },
        ada.token,
      )
    ).body as { id: string };
    expect((await getExpense(whole, ada.token)).body).toMatchObject({ amount: 7, original: { rate: '1' } });
  });

  it('reads an expense in the group currency as before, with no original', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    const { id } = (
      await record(
        groupId,
        { description: 'Bread', amount: 300, date: '2020-01-15', splitBetween: [ada.id] },
        ada.token,
      )
    ).body as { id: string };
    expect((await getExpense(id, ada.token)).body).not.toHaveProperty('original');
  });

  it('is refused for its shape when it has neither amount nor original, or both', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    const base = { description: 'Dinner', date: '2020-01-15', splitBetween: [ada.id] };
    const neither = await record(groupId, base, ada.token);
    expect(neither.status).toBe(400);
    const both = await record(
      groupId,
      { ...base, amount: 1000, original: { currency: 'CHF', amount: 1000, rate: '1' } },
      ada.token,
    );
    expect(both.status).toBe(400);
    const rateAsNumber = await record(
      groupId,
      { ...base, original: { currency: 'CHF', amount: 1000, rate: 1.0625 } },
      ada.token,
    );
    expect(rateAsNumber.status).toBe(400);
  });

  it("is refused by name for the values it does not allow: the group currency, a currency that is not Tally's, a rate, an amount", async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    const base = { description: 'Dinner', date: '2020-01-15', splitBetween: [ada.id] };
    const cases: [Record<string, unknown>, string][] = [
      [{ ...base, original: { currency: 'EUR', amount: 1000, rate: '1' } }, 'OriginalCurrencyIsGroupCurrency'],
      [{ ...base, original: { currency: 'JPY', amount: 1000, rate: '1' } }, 'InvalidOriginalCurrency'],
      [{ ...base, original: { currency: 'CHF', amount: 1000, rate: '1.1234567' } }, 'InvalidExpenseRate'],
      [{ ...base, original: { currency: 'CHF', amount: 1000, rate: '0' } }, 'InvalidExpenseRate'],
      [{ ...base, original: { currency: 'CHF', amount: 0, rate: '1' } }, 'InvalidOriginalAmount'],
      [{ ...base, original: { currency: 'CHF', amount: 100_000_000, rate: '2' } }, 'InvalidExpenseAmount'],
      [{ ...base, original: { currency: 'CHF', amount: 1, rate: '0.000001' } }, 'InvalidExpenseAmount'],
    ];
    for (const [body, type] of cases) {
      const answer = await record(groupId, body, ada.token);
      expect(answer.status).toBe(400);
      expect(answer.body).toEqual({ type, message: expect.any(String) });
    }
  });
});

describe('editing an expense paid in another currency', () => {
  it('gives it whole again: an original, then an amount in the group currency, which drops the original', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);
    const { id } = (
      await record(
        groupId,
        { description: 'Dinner', amount: 1000, date: '2020-01-15', splitBetween: [ada.id, grace.id] },
        ada.token,
      )
    ).body as { id: string };

    const toOriginal = await edit(
      id,
      {
        description: 'Dinner',
        original: { currency: 'USD', amount: 2000, rate: '0.5' },
        date: '2020-01-15',
        splitBetween: [ada.id, grace.id],
        version: 1,
      },
      ada.token,
    );
    expect(toOriginal.status).toBe(204);
    expect((await getExpense(id, grace.token)).body).toMatchObject({
      amount: 1000,
      original: { currency: 'USD', amount: 2000, rate: '0.5' },
      version: 2,
    });

    const toAmount = await edit(
      id,
      { description: 'Dinner', amount: 900, date: '2020-01-15', splitBetween: [ada.id, grace.id], version: 2 },
      ada.token,
    );
    expect(toAmount.status).toBe(204);
    const read = (await getExpense(id, grace.token)).body as Record<string, unknown>;
    expect(read).toMatchObject({ amount: 900, version: 3 });
    expect(read).not.toHaveProperty('original');
  });

  it('is refused by name for an original the domain does not allow, and the expense stays as it was', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    const { id } = (
      await record(
        groupId,
        { description: 'Dinner', amount: 1000, date: '2020-01-15', splitBetween: [ada.id] },
        ada.token,
      )
    ).body as { id: string };

    const refused = await edit(
      id,
      {
        description: 'Dinner',
        original: { currency: 'EUR', amount: 1000, rate: '1' },
        date: '2020-01-15',
        splitBetween: [ada.id],
        version: 1,
      },
      ada.token,
    );
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ type: 'OriginalCurrencyIsGroupCurrency', message: expect.any(String) });
    expect((await getExpense(id, ada.token)).body).toMatchObject({ amount: 1000, version: 1 });
  });
});
