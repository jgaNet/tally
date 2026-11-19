import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/*
 * Request 40: four currencies more, JPY and KRW with no minor unit, KWD and BHD with three decimals. Every amount is in its
 * currency's own minor unit, and between two currencies of another precision a rate is what one unit of each is worth.
 */

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let serverToday: string;

beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'clock-precision@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((signUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
});

afterAll(() => app.stop());

type Body = Record<string, unknown>;

/** Follows an operation to its outcome, as a client does. */
async function outcome(operationId: string, token?: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    if (status !== 200 || (body as Body).status !== 'PENDING') return { status, body: body as Body };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

let accountCount = 0;

/** Signs up and in a new account, and answers its token and its id. */
async function person(name: string) {
  const email = `${name.toLowerCase()}-precision-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Sends a command as a client does: the `202`, then the operation followed to its outcome. */
async function send(method: 'POST' | 'PUT', path: string, token: string | undefined, body: Body) {
  const answer = await http.request(method, `${api}${path}`, { body, token });
  if (answer.status !== 202) return { answer, done: undefined as Body | undefined };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { answer, done: done.body as Body };
}

/** Creates a group in `currency` and answers its id. */
async function createGroup(owner: { token: string }, currency: string) {
  const { done } = await send('POST', '/groups', owner.token, { name: `Group in ${currency}`, currency });
  return (done as { result: { id: string } }).result.id;
}

const expenseOf = async (id: string, token: string) =>
  (await http.get(`${api}/expenses/${id}`, { token })).body as Body;

describe('currencies of another precision (request 40)', () => {
  it('allows currencies with no minor unit or with three decimals, and keeps each amount in its own minor unit', async () => {
    const alice = await person('Alice');
    for (const currency of ['JPY', 'KRW', 'KWD', 'BHD']) {
      const groupId = await createGroup(alice, currency);
      const group = await http.get(`${api}/groups/${groupId}`, { token: alice.token });
      expect(group.body).toMatchObject({ id: groupId, currency });
    }

    // 1250 is 1250 yen, and 1.250 dinars: the same whole number, each in its own minor unit.
    const yen = await createGroup(alice, 'JPY');
    const yenExpense = await send('POST', `/groups/${yen}/expenses`, alice.token, {
      description: 'Ramen',
      amount: 1250,
      date: serverToday,
      splitBetween: [alice.id],
    });
    expect(yenExpense.done).toMatchObject({ status: 'SUCCESS', result: { id: expect.any(String) } });
    const yenId = (yenExpense.done as { result: { id: string } }).result.id;
    expect(await expenseOf(yenId, alice.token)).toMatchObject({ groupId: yen, amount: 1250 });

    const dinars = await createGroup(alice, 'KWD');
    const dinarExpense = await send('POST', `/groups/${dinars}/expenses`, alice.token, {
      description: 'Lunch',
      amount: 1250,
      date: serverToday,
      splitBetween: [alice.id],
    });
    expect(dinarExpense.done).toMatchObject({ status: 'SUCCESS' });
    const dinarId = (dinarExpense.done as { result: { id: string } }).result.id;
    expect(await expenseOf(dinarId, alice.token)).toMatchObject({ groupId: dinars, amount: 1250 });
  });

  it('converts between currencies of different precision by what one unit of each is worth', async () => {
    const alice = await person('Alice');

    // A group in euros, paid in yen: 10 000 yen at 0.0062 euros to the yen is 62 euros, so 6200 hundredths.
    const euros = await createGroup(alice, 'EUR');
    const fromYen = await send('POST', `/groups/${euros}/expenses`, alice.token, {
      description: 'Sushi',
      original: { currency: 'JPY', amount: 10000, rate: '0.0062' },
      date: serverToday,
      splitBetween: [alice.id],
    });
    expect(fromYen.done).toMatchObject({ status: 'SUCCESS' });
    const fromYenId = (fromYen.done as { result: { id: string } }).result.id;
    expect(await expenseOf(fromYenId, alice.token)).toMatchObject({
      amount: 6200,
      original: { currency: 'JPY', amount: 10000, rate: '0.0062' },
    });

    // A group in yen, paid in euros: 12.50 euros at 161.5 yen to the euro is 2018.75 yen, so 2019.
    const yen = await createGroup(alice, 'JPY');
    const fromEuros = await send('POST', `/groups/${yen}/expenses`, alice.token, {
      description: 'Train',
      original: { currency: 'EUR', amount: 1250, rate: '161.5' },
      date: serverToday,
      splitBetween: [alice.id],
    });
    expect(fromEuros.done).toMatchObject({ status: 'SUCCESS' });
    const fromEurosId = (fromEuros.done as { result: { id: string } }).result.id;
    expect(await expenseOf(fromEurosId, alice.token)).toMatchObject({ amount: 2019 });

    // A group in dinars, paid in dollars: 10 dollars at 0.3075 dinars to the dollar is 3.075 dinars, so 3075.
    const dinars = await createGroup(alice, 'KWD');
    const fromDollars = await send('POST', `/groups/${dinars}/expenses`, alice.token, {
      description: 'Books',
      original: { currency: 'USD', amount: 1000, rate: '0.3075' },
      date: serverToday,
      splitBetween: [alice.id],
    });
    expect(fromDollars.done).toMatchObject({ status: 'SUCCESS' });
    const fromDollarsId = (fromDollars.done as { result: { id: string } }).result.id;
    expect(await expenseOf(fromDollarsId, alice.token)).toMatchObject({ amount: 3075 });
  });
});
