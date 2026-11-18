import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

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

type Operation = { status: string; result?: string; error?: { type: string; message: string } };
type Insight = { month: string; currency: string; category: string; amount: number };

/** Follows an operation to its end, as a client answered 202 does. */
async function outcome(operationId: string, token?: string): Promise<Operation> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    expect(status).toBe(200);
    if ((body as Operation).status !== 'PENDING') return body as Operation;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

/** Signs someone up and in, under the name given: their account's id, and the token that names it. */
async function signedIn(email: string, name: string): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password: 'correct horse', name } });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: 'correct horse' } });
  return { id: operation.result as string, token: (login.body as { token: string }).token };
}

async function createGroup(token: string, name: string, currency: string): Promise<string> {
  const answer = await http.request('POST', `${api}/groups`, { token, body: { name, currency } });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

async function join(token: string, groupId: string, joiner: string): Promise<void> {
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, token)).result as string;
  const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: joiner });
  await outcome((accepted.body as { operationId: string }).operationId, joiner);
}

/** Records an expense and follows its operation: SUCCESS with the id, or ERROR with the refusal. */
async function record(
  token: string,
  groupId: string,
  body: { description: string; amount: number; date: string; category: string; splitBetween: string[] },
): Promise<Operation> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

/** A command that is answered 202 and read at its operation; the outcome of it. */
async function command(method: 'POST' | 'DELETE', path: string, token: string): Promise<Operation> {
  const answer = await http.request(method, `${api}${path}`, { token });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

async function insights(token?: string): Promise<{ status: number; body: unknown }> {
  return http.get(`${api}/accounts/me/insights`, { token });
}

/** The lines as a person reads them, one per line of text. */
const lines = (body: unknown): string[] =>
  (body as Insight[]).map(line => `${line.month} ${line.currency} ${line.category} ${line.amount}`);

describe('spending insights (request 37)', () => {
  it('reads what one spent per month, currency and category across their groups, the earliest first', async () => {
    const ann = await signedIn('insights-ann@example.com', 'Ann');
    const ben = await signedIn('insights-ben@example.com', 'Ben');
    const flat = await createGroup(ann.token, 'Flat', 'EUR');
    await join(ann.token, flat, ben.token);
    const trip = await createGroup(ann.token, 'Trip', 'CHF');
    await join(ann.token, trip, ben.token);

    const groceries = { category: 'groceries', splitBetween: [ann.id, ben.id] };
    expect(
      await record(ann.token, flat, { description: 'Shop', amount: 8000, date: '2026-03-10', ...groceries }),
    ).toMatchObject({ status: 'SUCCESS' });
    expect(
      await record(ann.token, flat, { description: 'Shop again', amount: 7000, date: '2026-04-10', ...groceries }),
    ).toMatchObject({ status: 'SUCCESS' });
    expect(
      await record(ann.token, trip, {
        description: 'Train',
        amount: 50000,
        date: '2026-04-12',
        category: 'travel',
        splitBetween: [ann.id, ben.id],
      }),
    ).toMatchObject({ status: 'SUCCESS' });

    const read = await insights(ann.token);
    expect(read.status).toBe(200);
    expect(lines(read.body)).toEqual([
      '2026-03 EUR groceries 4000',
      '2026-04 CHF travel 25000',
      '2026-04 EUR groceries 3500',
    ]);
  });

  it('reads nothing for a person in no group, and refuses a read with no caller at once', async () => {
    const carl = await signedIn('insights-carl@example.com', 'Carl');
    expect(await insights(carl.token)).toMatchObject({ status: 200, body: [] });
    expect((await insights()).status).toBe(401);
  });

  it('counts a deleted expense for nothing, and a group they have left for nothing', async () => {
    const ben = await signedIn('insights-ben-leave@example.com', 'Ben');
    const dan = await signedIn('insights-dan-leave@example.com', 'Dan');
    const bike = await createGroup(ben.token, 'Bike', 'CHF');
    await join(ben.token, bike, dan.token);

    // Dan pays for what is his alone, so his balance stays at 0 and he may leave the group.
    const leisure = await record(dan.token, bike, {
      description: 'Ticket',
      amount: 1000,
      date: '2026-04-10',
      category: 'leisure',
      splitBetween: [dan.id],
    });
    expect(leisure).toMatchObject({ status: 'SUCCESS' });
    const food = await record(dan.token, bike, {
      description: 'Snack',
      amount: 600,
      date: '2026-04-11',
      category: 'food',
      splitBetween: [dan.id],
    });
    expect(food).toMatchObject({ status: 'SUCCESS' });
    expect(lines((await insights(dan.token)).body)).toEqual(['2026-04 CHF food 600', '2026-04 CHF leisure 1000']);

    expect(await command('DELETE', `/expenses/${food.result}`, dan.token)).toMatchObject({ status: 'SUCCESS' });
    expect(lines((await insights(dan.token)).body)).toEqual(['2026-04 CHF leisure 1000']);

    expect(await command('POST', `/groups/${bike}/leave`, dan.token)).toMatchObject({ status: 'SUCCESS' });
    expect((await insights(dan.token)).body).toEqual([]);
  });
});
