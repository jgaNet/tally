import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabaseUrl } from '../test-support';
import { todayInUtc } from '../expenses/validation';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WEEK = 7 * DAY;
const START = Date.parse('2026-01-05T09:00:00.000Z');

describe('reminders are for more than 20 of the group’s currency, in its minor unit', () => {
  let app: Application;
  let databaseUrl: string;

  beforeEach(async () => {
    databaseUrl = await temporaryDatabaseUrl();
    app = await createApplication({ databaseUrl });
  });

  afterEach(async () => {
    await app.stop();
  });

  /** Ada owns a group in `currency` with Grace in it; Ada paid `paid` split between them, so Grace owes half of it. */
  let accounts = 0;
  async function graceOwes(currency: string, paid: number) {
    accounts += 1;
    const ada = await signedUpAccount(app, { email: `ada${accounts}@example.com` });
    const grace = await signedUpAccount(app, { email: `grace${accounts}@example.com`, name: 'Grace' });
    const created = await send(app, 'POST', '/groups', { token: ada.token, payload: { name: 'Trip', currency } });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    const expense = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ada.token,
      payload: { description: 'Dinner', amount: paid, date: todayInUtc(), splitBetween: [ada.id, grace.id] },
    });
    expect(expense.statusCode).toBe(201);
    return { grace };
  }

  async function remindersOf(token: string) {
    const response = await send(app, 'GET', '/notices', { token });
    expect(response.statusCode).toBe(200);
    return response
      .json<{ kind: string; groupId: string; amount: number; at: string }[]>()
      .filter(notice => notice.kind === 'reminder');
  }

  const at = (ms: number) => new Date(ms);

  it('reminds a member in yen who owes 21 yen, and not one who owes 20, which is not more than 20', async () => {
    const owing21 = await graceOwes('JPY', 42);
    const owing20 = await graceOwes('JPY', 40);
    await app.runJobs(at(START));
    await app.runJobs(at(START + WEEK));

    const reminders = await remindersOf(owing21.grace.token);
    expect(reminders).toEqual([expect.objectContaining({ kind: 'reminder', amount: 21 })]);
    expect(await remindersOf(owing20.grace.token)).toEqual([]);
  });

  it('reminds a member in dinars who owes 20.001 dinars, and not one who owes exactly 20', async () => {
    const owing20001 = await graceOwes('KWD', 40_002);
    const owing20000 = await graceOwes('KWD', 40_000);
    await app.runJobs(at(START));
    await app.runJobs(at(START + WEEK));

    const reminders = await remindersOf(owing20001.grace.token);
    expect(reminders).toEqual([expect.objectContaining({ kind: 'reminder', amount: 20_001 })]);
    expect(await remindersOf(owing20000.grace.token)).toEqual([]);
  });

  it('still reminds a member in euros who owes more than 2000 hundredths, and not one who owes exactly 2000', async () => {
    const owing2001 = await graceOwes('EUR', 4002);
    const owing2000 = await graceOwes('EUR', 4000);
    await app.runJobs(at(START));
    await app.runJobs(at(START + WEEK));

    expect(await remindersOf(owing2001.grace.token)).toEqual([expect.objectContaining({ amount: 2001 })]);
    expect(await remindersOf(owing2000.grace.token)).toEqual([]);
  });
});
