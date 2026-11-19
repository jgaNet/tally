import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Groups → Ledger over `GroupsMerged` (request 31, ADR 28): a group merged into another hands its expenses to Ledger's reaction, which moves
 * them to the group kept. The expense is found in the group kept by the id its recording answered, and keeps its version and its payer.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_URL = await freshDatabaseUrl();
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

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

describe('Groups → Ledger', () => {
  it('moves an expense recorded in the group merged to the group kept, by the id its recording answered', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const kept = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };
    const merged = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Annex', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };
    const invitation = (await http.request('POST', `${api}/groups/${merged.id}/invitations`, { token: ada.token }))
      .body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token });
    const recorded = await http.request('POST', `${api}/groups/${merged.id}/expenses`, {
      body: { description: 'Gas', amount: 40, date: '2020-03-01', splitBetween: [ada.id, grace.id] },
      token: ada.token,
    });
    const { id: expenseId } = recorded.body as { id: string };

    expect(
      (await http.request('POST', `${api}/groups/${kept.id}/merge`, { body: { from: merged.id }, token: ada.token }))
        .status,
    ).toBe(204);

    let found: { id: string; version: number; paidBy: string } | undefined;
    for (let attempt = 0; attempt < 100 && !found; attempt += 1) {
      const expenses = (await http.request('GET', `${api}/groups/${kept.id}/expenses`, { token: ada.token })).body as {
        id: string;
        version: number;
        paidBy: string;
      }[];
      found = expenses.find(expense => expense.id === expenseId);
      if (!found) await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(found).toMatchObject({ id: expenseId, paidBy: ada.id, version: 1 });
    const read = await http.request('GET', `${api}/expenses/${expenseId}`, { token: ada.token });
    expect(read.body).toMatchObject({ id: expenseId, groupId: kept.id, paidBy: ada.id, amount: 40 });
  });
});
