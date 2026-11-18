import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * An expense in another currency, end to end (request 21): the application booted in this process on a free port, spoken
 * to over HTTP, every answer held to api/21-another-currency.yaml by the client. One application per suite, shared by its
 * tests in order. The group counts in EUR.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});
afterAll(() => app.stop());

const PASSWORD = 'correct horse';
const SPENT = '2020-01-02';

async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

async function groupWith(owner: { token: string }, others: { token: string }[]): Promise<string> {
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'The week in Zurich', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (created.body as { id: string }).id;
  for (const other of others) {
    const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
    const invitationId = (invitation.body as { id: string }).id;
    const joined = await http.request('POST', `/v1/invitations/${invitationId}/accept`, { token: other.token });
    expect(joined.status).toBe(201);
  }
  return groupId;
}

const record = (groupId: string, token: string | undefined, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/expenses`, { body, token });
const readExpense = (id: string, token?: string) => http.get(`/v1/expenses/${id}`, { token });
const editExpense = (id: string, token: string | undefined, body: unknown) =>
  http.request('PUT', `/v1/expenses/${id}`, { body, token });
const balancesOf = (groupId: string, token: string) => http.get(`/v1/groups/${groupId}/balances`, { token });

describe('Groups → Ledger: an expense in another currency (request 21)', () => {
  it('reads the currency the group counts in from Groups, so a group in francs converts an expense paid in euros into francs', async () => {
    const ana = await accountOf('ana.chf@example.com', 'Ana');
    const created = await http.request('POST', '/v1/groups', {
      body: { name: 'Zurich, in francs', currency: 'CHF' },
      token: ana.token,
    });
    const groupId = (created.body as { id: string }).id;

    const recorded = await record(groupId, ana.token, {
      description: 'Lunch',
      original: { currency: 'EUR', amount: 1000, rate: '0.9545' },
      date: SPENT,
      splitBetween: [ana.id],
    });
    expect(recorded.status).toBe(201);

    expect(await readExpense((recorded.body as { id: string }).id, ana.token)).toMatchObject({
      status: 200,
      body: { amount: 955, original: { currency: 'EUR', amount: 1000, rate: '0.9545' } },
    });
    const refusedInTheGroupsOwn = await record(groupId, ana.token, {
      description: 'Lunch',
      original: { currency: 'CHF', amount: 1000, rate: '1' },
      date: SPENT,
      splitBetween: [ana.id],
    });
    expect(refusedInTheGroupsOwn.body).toMatchObject({ type: 'InvalidOriginalCurrency' });
  });

  it('converts what was paid at its rate, splits the amount in the group’s currency, and reads back the currency, the amounts and the rate', async () => {
    const ana = await accountOf('ana.francs@example.com', 'Ana');
    const ben = await accountOf('ben.francs@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);

    const recorded = await record(groupId, ana.token, {
      description: 'Train tickets',
      original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
      date: SPENT,
      splitBetween: [ana.id, ben.id],
    });
    expect(recorded.status).toBe(201);
    const expenseId = (recorded.body as { id: string }).id;

    const read = await readExpense(expenseId, ben.token);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      amount: 1311,
      original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
      splitKind: 'equal',
    });
    const shares = (read.body as { shares: { amount: number }[] }).shares;
    expect(shares.reduce((sum, share) => sum + share.amount, 0)).toBe(1311);

    const balances = await balancesOf(groupId, ana.token);
    const total = (balances.body as { balance: number }[]).reduce((sum, row) => sum + row.balance, 0);
    expect(total).toBe(0);
  });

  it('rounds a half up, and an exact split adds up to the amount in the group’s currency', async () => {
    const ana = await accountOf('ana.half@example.com', 'Ana');
    const ben = await accountOf('ben.half@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);

    const half = await record(groupId, ana.token, {
      description: 'Museum',
      original: { currency: 'USD', amount: 1000, rate: '0.9545' },
      date: SPENT,
      splitExactly: [
        { memberId: ana.id, amount: 455 },
        { memberId: ben.id, amount: 500 },
      ],
    });
    expect(half.status).toBe(201);
    expect(await readExpense((half.body as { id: string }).id, ana.token)).toMatchObject({
      body: { amount: 955, original: { currency: 'USD', amount: 1000, rate: '0.9545' } },
    });
  });

  it('keeps the rate as the same string, and an expense in the group’s currency reads without `original`', async () => {
    const ana = await accountOf('ana.plain@example.com', 'Ana');
    const groupId = await groupWith(ana, []);

    const whole = await record(groupId, ana.token, {
      description: 'Rent share',
      original: { currency: 'GBP', amount: 500, rate: '1' },
      date: SPENT,
      splitBetween: [ana.id],
    });
    const plain = await record(groupId, ana.token, {
      description: 'Bread',
      amount: 300,
      date: SPENT,
      splitBetween: [ana.id],
    });

    const readWhole = await readExpense((whole.body as { id: string }).id, ana.token);
    const readPlain = await readExpense((plain.body as { id: string }).id, ana.token);
    expect(readWhole.body).toMatchObject({ amount: 500, original: { currency: 'GBP', amount: 500, rate: '1' } });
    expect(readPlain.status).toBe(200);
    expect(readPlain.body).not.toHaveProperty('original');
  });

  it('refuses by name a currency that is the group’s or not Tally’s, an amount out of range, a rate the rules do not allow, and a converted amount out of range', async () => {
    const ana = await accountOf('ana.refuse@example.com', 'Ana');
    const groupId = await groupWith(ana, []);
    const base = { description: 'Coffee', date: SPENT, splitBetween: [ana.id] };

    const sameAsGroup = await record(groupId, ana.token, {
      ...base,
      original: { currency: 'EUR', amount: 300, rate: '1' },
    });
    const notTally = await record(groupId, ana.token, {
      ...base,
      original: { currency: 'JPY', amount: 300, rate: '1' },
    });
    const zeroAmount = await record(groupId, ana.token, {
      ...base,
      original: { currency: 'CHF', amount: 0, rate: '1' },
    });
    const zeroRate = await record(groupId, ana.token, {
      ...base,
      original: { currency: 'CHF', amount: 300, rate: '0' },
    });
    const sevenDigits = await record(groupId, ana.token, {
      ...base,
      original: { currency: 'CHF', amount: 300, rate: '1.0000001' },
    });
    const noLeadingDigit = await record(groupId, ana.token, {
      ...base,
      original: { currency: 'CHF', amount: 300, rate: '.5' },
    });
    const rounds = await record(groupId, ana.token, { ...base, original: { currency: 'CHF', amount: 1, rate: '0.4' } });

    expect(sameAsGroup.body).toMatchObject({ type: 'InvalidOriginalCurrency' });
    expect(notTally.body).toMatchObject({ type: 'InvalidOriginalCurrency' });
    expect(zeroAmount.body).toMatchObject({ type: 'InvalidOriginalAmount' });
    expect(zeroRate.body).toMatchObject({ type: 'InvalidRate' });
    expect(sevenDigits.body).toMatchObject({ type: 'InvalidRate' });
    expect(noLeadingDigit.body).toMatchObject({ type: 'InvalidRate' });
    expect(rounds.body).toMatchObject({ type: 'InvalidAmount' });
    for (const answer of [sameAsGroup, notTally, zeroAmount, zeroRate, sevenDigits, noLeadingDigit, rounds]) {
      expect(answer.status).toBe(400);
    }
  });

  it('refuses a body with both `amount` and `original`, or with neither, as the wrong shape', async () => {
    const ana = await accountOf('ana.shape@example.com', 'Ana');
    const groupId = await groupWith(ana, []);
    const base = { description: 'Coffee', date: SPENT, splitBetween: [ana.id] };
    const original = { currency: 'CHF', amount: 300, rate: '1' };

    const both = await record(groupId, ana.token, { ...base, amount: 300, original });
    const neither = await record(groupId, ana.token, base);

    expect(both.status).toBe(400);
    expect(neither.status).toBe(400);
  });

  it('edits an expense whole: in another currency at its new rate, or in the group’s currency, which drops `original`', async () => {
    const ana = await accountOf('ana.edit-fx@example.com', 'Ana');
    const groupId = await groupWith(ana, []);
    const expenseId = (
      (
        await record(groupId, ana.token, {
          description: 'Train',
          original: { currency: 'CHF', amount: 1000, rate: '0.95' },
          date: SPENT,
          splitBetween: [ana.id],
        })
      ).body as { id: string }
    ).id;

    const reRated = await editExpense(expenseId, ana.token, {
      description: 'Train',
      original: { currency: 'CHF', amount: 1000, rate: '1.02' },
      date: SPENT,
      splitBetween: [ana.id],
      version: 1,
    });
    expect(reRated.status).toBe(201);
    expect(await readExpense(expenseId, ana.token)).toMatchObject({
      body: { amount: 1020, version: 2, original: { currency: 'CHF', amount: 1000, rate: '1.02' } },
    });

    const inEuros = await editExpense(expenseId, ana.token, {
      description: 'Train',
      amount: 990,
      date: SPENT,
      splitBetween: [ana.id],
      version: 2,
    });
    expect(inEuros.status).toBe(201);
    const read = await readExpense(expenseId, ana.token);
    expect(read.body).toMatchObject({ amount: 990, version: 3 });
    expect(read.body).not.toHaveProperty('original');
  });
});
