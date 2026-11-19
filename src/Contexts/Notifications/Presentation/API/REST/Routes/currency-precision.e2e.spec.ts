import { jest } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { sweepDebts } from '@Bootstrap/Fastify/jobs';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const DAY = 86_400_000;
/** The instant the test starts at. The system clock reads the faked Date, so a test moves time with `jest.setSystemTime`. */
const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);

beforeAll(async () => {
  jest.useFakeTimers({
    now: T0,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  jest.useRealTimers();
});

type Operation = { status: string; result?: string; error?: { type: string; message: string } };
type Notice = {
  id: string;
  kind: 'expense' | 'reminder';
  groupId: string;
  expenseId?: string;
  amount: number;
  at: string;
};

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

async function signedIn(email: string, name: string): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email, password: 'correct horse', name },
  });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, {
    body: { email, password: 'correct horse' },
  });
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

/** Records an expense of `amount` paid by the caller, split equally between the members given. */
async function record(token: string, groupId: string, amount: number, members: string[]): Promise<void> {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token,
    body: { description: 'Holiday', amount, date: '2026-03-10', splitBetween: members },
  });
  await outcome((answer.body as { operationId: string }).operationId, token);
}

async function reminders(token: string): Promise<Notice[]> {
  const { status, body } = await http.get(`${api}/notices`, { token });
  expect(status).toBe(200);
  return (body as Notice[]).filter(notice => notice.kind === 'reminder');
}

describe('Settlements → Notifications (OutstandingDebts): a reminder is for more than 20 of the group currency (request 40)', () => {
  it('reminds 30 yen, and a debt a cash settlement in yen pays is not reminded', async () => {
    const ann = await signedIn('precision-ann@example.com', 'Ann');
    const ben = await signedIn('precision-ben@example.com', 'Ben');
    const cy = await signedIn('precision-cy@example.com', 'Cy');
    const group = await createGroup(ann.token, 'Tokyo', 'JPY');
    await join(ann.token, group, ben.token);
    await join(ann.token, group, cy.token);
    // Ann paid 90 yen split three ways: Ben and Cy each owe 30 yen, more than 20.
    await record(ann.token, group, 90, [ann.id, ben.id, cy.id]);
    await sweepDebts(app);

    const recorded = await http.request('POST', `${api}/groups/${group}/settlements/cash`, {
      token: ann.token,
      body: { from: ben.id, amount: 30 },
    });
    const settlement = (await outcome((recorded.body as { operationId: string }).operationId, ann.token))
      .result as string;
    const read = await http.get(`${api}/settlements/${settlement}`, { token: ann.token });
    expect(read.body).toMatchObject({ id: settlement, from: ben.id, to: ann.id, amount: 30, status: 'paid' });

    jest.setSystemTime(T0 + 7 * DAY);
    await sweepDebts(app);
    expect(await reminders(ben.token)).toEqual([]);
    expect(await reminders(cy.token)).toEqual([
      {
        id: expect.any(String),
        kind: 'reminder',
        groupId: group,
        amount: 30,
        at: new Date(T0 + 7 * DAY).toISOString(),
      },
    ]);
  });

  it('does not remind 20 000 thousandths of a dinar, and reminds 20 001', async () => {
    const ann = await signedIn('precision-dan@example.com', 'Dan');
    const ben = await signedIn('precision-eve@example.com', 'Eve');
    const cy = await signedIn('precision-fay@example.com', 'Fay');
    const group = await createGroup(ann.token, 'Kuwait', 'KWD');
    await join(ann.token, group, ben.token);
    await join(ann.token, group, cy.token);
    // 60.000 dinars split three ways: 20.000 each, which is 20 dinars, not more than 20.
    await record(ann.token, group, 60_000, [ann.id, ben.id, cy.id]);
    jest.setSystemTime(T0 + 14 * DAY);
    await sweepDebts(app);
    jest.setSystemTime(T0 + 22 * DAY);
    await sweepDebts(app);
    expect(await reminders(cy.token)).toEqual([]);

    // Three thousandths more, one each: 20.001 dinars, more than 20.
    await record(ann.token, group, 3, [ann.id, ben.id, cy.id]);
    jest.setSystemTime(T0 + 23 * DAY);
    await sweepDebts(app);
    jest.setSystemTime(T0 + 31 * DAY);
    await sweepDebts(app);
    expect(await reminders(cy.token)).toEqual([
      {
        id: expect.any(String),
        kind: 'reminder',
        groupId: group,
        amount: 20_001,
        at: new Date(T0 + 31 * DAY).toISOString(),
      },
    ]);
  });
});
