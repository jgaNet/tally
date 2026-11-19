import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Notice preferences (request 36, ADR 34): a person reads their own preferences, each kind in order, and turns each kind on or off. A
 * notice of a kind turned off is not made for them from then on; the others of the group are told as before, and a reminder not made
 * does not count as made, so the first run after the reminders are on again reminds them. The job runs every tenth of a second and a
 * period is a second here, as in the reminders' own test.
 */

const PERIOD_MS = 1000;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const name of ['DATABASE_PATH', 'JOBS_INTERVAL_SECONDS', 'REMINDER_PERIOD_SECONDS'])
    saved[name] = process.env[name];
  process.env.DATABASE_URL = await freshDatabaseUrl();
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

async function groupOfThree() {
  const ada = await signedInPerson('Ada');
  const grace = await signedInPerson('Grace');
  const linus = await signedInPerson('Linus');
  const { id: groupId } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
  ).body as { id: string };
  for (const person of [grace, linus]) {
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  return { ada, grace, linus, groupId };
}

type Notice = { id: string; kind: string; groupId: string; amount: number; at: string; expenseId?: string };
const noticesOf = async (person: { token: string }): Promise<Notice[]> =>
  (await http.request('GET', `${api}/notices`, { token: person.token })).body as Notice[];
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Polls the person's notices until `count` of `kind` have arrived, for at most about three seconds. */
async function noticesUntil(person: { token: string }, kind: string, count: number): Promise<Notice[]> {
  let found: Notice[] = [];
  for (let poll = 0; poll < 120; poll++) {
    found = (await noticesOf(person)).filter(notice => notice.kind === kind);
    if (found.length >= count) break;
    await wait(25);
  }
  return found;
}

describe('Notice preferences', () => {
  it('has every kind on, in order, until a person turns it off, and tells nobody else', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const everyKindOn = [
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: true },
      { kind: 'budget', enabled: true },
    ];
    expect((await http.request('GET', `${api}/accounts/me/notice-preferences`, { token: ada.token })).body).toEqual(
      everyKindOn,
    );

    expect(
      (
        await http.request('PUT', `${api}/accounts/me/notice-preferences/reminder`, {
          body: { enabled: false },
          token: ada.token,
        })
      ).status,
    ).toBe(204);
    expect((await http.request('GET', `${api}/accounts/me/notice-preferences`, { token: ada.token })).body).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: false },
      { kind: 'budget', enabled: true },
    ]);
    expect((await http.request('GET', `${api}/accounts/me/notice-preferences`, { token: grace.token })).body).toEqual(
      everyKindOn,
    );

    await http.request('PUT', `${api}/accounts/me/notice-preferences/reminder`, {
      body: { enabled: true },
      token: ada.token,
    });
    expect((await http.request('GET', `${api}/accounts/me/notice-preferences`, { token: ada.token })).body).toEqual(
      everyKindOn,
    );
  });

  it('answers 401 to a caller who is not signed in, 400 to a body that is not a boolean, and refuses a kind that is none of the three', async () => {
    const ada = await signedInPerson('Ada');
    const url = `${api}/accounts/me/notice-preferences`;
    expect((await http.request('GET', url)).status).toBe(401);
    expect((await http.request('PUT', `${url}/budget`, { body: { enabled: false } })).status).toBe(401);

    expect((await http.request('PUT', `${url}/budget`, { body: { enabled: 'no' }, token: ada.token })).status).toBe(
      400,
    );

    const refused = await http.request('PUT', `${url}/newsletter`, { body: { enabled: false }, token: ada.token });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ type: 'InvalidNoticeKind' });
  });

  it('makes no reminder while reminders are off, and reminds on the first run after they are on again', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const { id: groupId } = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Rent', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token });
    await http.request('PUT', `${api}/accounts/me/notice-preferences/reminder`, {
      body: { enabled: false },
      token: grace.token,
    });
    expect(
      (
        await http.request('POST', `${api}/groups/${groupId}/expenses`, {
          body: { description: 'Rent', amount: 5000, date: '2026-03-01', splitBetween: [ada.id, grace.id] },
          token: ada.token,
        })
      ).status,
    ).toBe(201);

    // Grace owes 2500 for longer than a period, with reminders off: she is noted, and nothing is reminded.
    await wait(PERIOD_MS * 2.5);
    expect((await noticesOf(grace)).filter(notice => notice.kind === 'reminder')).toEqual([]);

    expect(
      (
        await http.request('PUT', `${api}/accounts/me/notice-preferences/reminder`, {
          body: { enabled: true },
          token: grace.token,
        })
      ).status,
    ).toBe(204);
    const [reminder] = await noticesUntil(grace, 'reminder', 1);
    expect(reminder).toMatchObject({ kind: 'reminder', groupId, amount: 2500 });
  }, 30_000);

  describe('Ledger → Notifications', () => {
    it('makes no expense notice for a member who has them turned off, from then on, and makes them again once they are on', async () => {
      const { ada, grace, linus, groupId } = await groupOfThree();
      await http.request('PUT', `${api}/accounts/me/notice-preferences/expense`, {
        body: { enabled: false },
        token: grace.token,
      });

      const first = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
        body: { description: 'Pizzas', amount: 300, date: '2026-03-01', splitBetween: [ada.id, grace.id, linus.id] },
        token: ada.token,
      });
      expect(first.status).toBe(201);
      // Linus's notice is the sign that the reaction has run: Grace's, had it been made, is made in the same reaction.
      expect(await noticesUntil(linus, 'expense', 1)).toHaveLength(1);
      expect(await noticesOf(grace)).toEqual([]);

      await http.request('PUT', `${api}/accounts/me/notice-preferences/expense`, {
        body: { enabled: true },
        token: grace.token,
      });
      const second = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
        body: { description: 'Bread', amount: 200, date: '2026-03-02', splitBetween: [ada.id, grace.id, linus.id] },
        token: ada.token,
      });
      expect(second.status).toBe(201);
      const [again] = await noticesUntil(grace, 'expense', 1);
      expect(again).toMatchObject({
        kind: 'expense',
        groupId,
        amount: 66,
        expenseId: (second.body as { id: string }).id,
      });
      expect(await noticesOf(linus)).toHaveLength(2);
    });

    it('tells nobody a budget passed while they have budget notices turned off, and tells the others once as before', async () => {
      const { ada, grace, linus, groupId } = await groupOfThree();
      const month = new Date(String((await http.request('GET', `${api}/accounts/me`)).headers.get('date')))
        .toISOString()
        .slice(0, 7);
      await http.request('PUT', `${api}/accounts/me/notice-preferences/budget`, {
        body: { enabled: false },
        token: linus.token,
      });
      expect(
        (
          await http.request('PUT', `${api}/groups/${groupId}/budgets/groceries`, {
            body: { amount: 200 },
            token: ada.token,
          })
        ).status,
      ).toBe(204);

      const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
        body: {
          description: 'Market',
          amount: 300,
          date: `${month}-01`,
          category: 'groceries',
          splitBetween: [ada.id, grace.id, linus.id],
        },
        token: grace.token,
      });
      expect(recorded.status).toBe(201);

      for (const person of [ada, grace]) {
        expect(await noticesUntil(person, 'budget', 1)).toEqual([
          expect.objectContaining({ groupId, category: 'groceries', month, budget: 200, amount: 300 }),
        ]);
      }
      // Linus has budget notices off and nothing else: the expense they are in is still notified to them.
      expect((await noticesOf(linus)).filter(notice => notice.kind === 'budget')).toEqual([]);
    });
  });
});
