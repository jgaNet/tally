import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Reminders, end to end (request 18): the application booted in this process with its background job on a short timer, as the
 * composition root schedules it, so a debt that lasts is reminded by the job and found over HTTP, held to api/18-reminders.yaml by
 * the client. The period is half a second here; a reminder is never made by a read.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
beforeAll(async () => {
  app = await createApplication({ jobsIntervalSeconds: 0.05, reminderPeriodSeconds: 0.5 });
  await app.start(0);
  http = apiClient(app.address);
});
afterAll(() => app.stop());

const PASSWORD = 'correct horse';
const SPENT = '2020-01-02';

/** Signs an account up and in, and answers its token and its id. */
async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

interface NoticeAnswer {
  id: string;
  kind: string;
  groupId: string;
  expenseId?: string;
  amount: number;
  at: string;
}

/** The reminders of the holder of `token`, read until there are `count` of them, for at most 6 seconds. */
async function remindersOnce(token: string, count: number): Promise<NoticeAnswer[]> {
  let reminders: NoticeAnswer[] = [];
  for (let attempt = 0; attempt < 120; attempt++) {
    const answer = await http.get('/v1/notices', { token });
    expect(answer.status).toBe(200);
    reminders = (answer.body as NoticeAnswer[]).filter(notice => notice.kind === 'reminder');
    if (reminders.length >= count) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return reminders;
}

describe('Settlements → Notifications', () => {
  it('reminds a member of what Settlements counts as still owed, with the settlement paid in cash taken off', async () => {
    const ann = await accountOf('ann.reminder.settlements@example.com', 'Ann');
    const bob = await accountOf('bob.reminder.settlements@example.com', 'Bob');
    const created = await http.request('POST', '/v1/groups', {
      body: { name: 'The villa', currency: 'EUR' },
      token: ann.token,
    });
    const groupId = (created.body as { id: string }).id;
    const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: ann.token });
    const joined = await http.request('POST', `/v1/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: bob.token,
    });
    expect(joined.status).toBe(201);

    // Bob owes Ann 5000 for the villa; then Bob pays 1000 in cash, which Ann records: 4000 is still owed.
    const villa = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
      body: { description: 'Villa', amount: 10000, date: SPENT, splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });
    expect(villa.status).toBe(201);
    const paid = await http.request('POST', `/v1/groups/${groupId}/settlements/cash`, {
      body: { from: bob.id, amount: 1000 },
      token: ann.token,
    });
    expect(paid.status).toBe(201);
    const settlementId = (paid.body as { id: string }).id;
    const settlement = await http.get(`/v1/settlements/${settlementId}`, { token: ann.token });
    expect(settlement.body).toMatchObject({ id: settlementId, groupId, from: bob.id, amount: 1000, status: 'paid' });

    const [reminder] = await remindersOnce(bob.token, 1);
    expect(reminder).toEqual({
      id: expect.any(String),
      kind: 'reminder',
      groupId,
      amount: 4000,
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
    expect(await remindersOnce(ann.token, 1)).toEqual([]); // Ann is owed, and reminded of nothing
  });
});
