import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Settlements → Notifications (ADR 15): at each run of the background job, Notifications asks Settlements, through its own port,
 * what each member still owes, and reminds the ones who have owed more than 2000 for a period. The job runs every tenth of a second
 * and a period is a second here, so that the test waits for it instead of changing the clock.
 */

const PERIOD_MS = 1000;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const name of ['DATABASE_PATH', 'JOBS_INTERVAL_SECONDS', 'REMINDER_PERIOD_SECONDS'])
    saved[name] = process.env[name];
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-settlements-to-notifications-')), 'tally.sqlite');
  process.env.JOBS_INTERVAL_SECONDS = '0.1';
  process.env.REMINDER_PERIOD_SECONDS = String(PERIOD_MS / 1000);
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

let accountCount = 0;
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

/** A group of Ada and Grace, in which Ada paid `amount`, split equally: Grace owes half of it. */
async function groupWhereGraceOwesHalfOf(amount: number) {
  const ada = await signedInPerson('Ada');
  const grace = await signedInPerson('Grace');
  const { id: groupId } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
  ).body as { id: string };
  const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
    .body as {
    id: string;
  };
  await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token });
  const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Rent', amount, date: '2026-03-01', splitBetween: [ada.id, grace.id] },
    token: ada.token,
  });
  expect(recorded.status).toBe(201);
  return { ada, grace, groupId };
}

type Notice = { id: string; kind: string; groupId: string; amount: number; at: string; expenseId?: string };
const noticesOf = async (person: { token: string }): Promise<Notice[]> =>
  (await http.request('GET', `${api}/notices`, { token: person.token })).body as Notice[];
const remindersOf = async (person: { token: string }): Promise<Notice[]> =>
  (await noticesOf(person)).filter(notice => notice.kind === 'reminder');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Reads the reminders every 50 ms until `count` have been made, for at most `polls` polls (the test never reads the machine's time). */
async function remindersUntil(person: { token: string }, count: number, polls: number): Promise<Notice[]> {
  let reminders = await remindersOf(person);
  for (let poll = 0; poll < polls && reminders.length < count; poll++) {
    await wait(50);
    reminders = await remindersOf(person);
  }
  return reminders;
}

describe('Settlements → Notifications', () => {
  it('reminds a member who owes more than 2000 once it has lasted a period, and again each period, until they pay', async () => {
    const { ada, grace, groupId } = await groupWhereGraceOwesHalfOf(5000);

    // Nothing is reminded because someone read something: the first period is not over yet.
    expect(await remindersOf(grace)).toEqual([]);

    const [first, second] = await remindersUntil(grace, 2, 200).then(reminders => [...reminders].reverse());
    expect(first).toEqual({ id: expect.any(String), kind: 'reminder', groupId, amount: 2500, at: expect.any(String) });
    expect('expenseId' in first).toBe(false);
    expect(Date.parse(second.at) - Date.parse(first.at)).toBeGreaterThanOrEqual(PERIOD_MS);
    expect(second.id).not.toEqual(first.id);

    // The creditor owes nothing: no reminder, only what they are owed is never a debt.
    expect(await remindersOf(ada)).toEqual([]);

    // Once Grace has paid in cash, what she owes is no more than 2000, and nobody reminds her again.
    const paid = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, amount: 2500 },
      token: ada.token,
    });
    expect(paid.status).toBe(201);
    await wait(300);
    const count = (await remindersOf(grace)).length;
    await wait(PERIOD_MS * 2.5);
    expect(await remindersOf(grace)).toHaveLength(count);
  }, 30_000);

  it('reminds nobody who owes 2000 or less', async () => {
    const { grace, ada } = await groupWhereGraceOwesHalfOf(4000);

    await wait(PERIOD_MS * 2.5);

    expect(await remindersOf(grace)).toEqual([]);
    expect(await remindersOf(ada)).toEqual([]);
  }, 30_000);
});
