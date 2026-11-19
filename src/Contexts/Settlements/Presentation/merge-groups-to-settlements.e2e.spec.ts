import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Groups → Settlements over `GroupsMerged` (request 31, ADR 28): a settlement recorded in the group merged is taken into the group kept's
 * book by the reaction of Settlements, with its status. It is found in the group kept by the id its recording answered.
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

describe('Groups → Settlements', () => {
  it('moves a settlement recorded in the group merged to the group kept, with its status, by the id it answered', async () => {
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
    await http.request('POST', `${api}/groups/${merged.id}/expenses`, {
      body: { description: 'Dinner', amount: 60, date: '2020-03-02', splitBetween: [ada.id, grace.id] },
      token: ada.token,
    });
    const settled = await http.request('POST', `${api}/groups/${merged.id}/settlements/cash`, {
      body: { from: grace.id, amount: 30 },
      token: ada.token,
    });
    const { id: settlementId } = settled.body as { id: string };

    expect(
      (await http.request('POST', `${api}/groups/${kept.id}/merge`, { body: { from: merged.id }, token: ada.token }))
        .status,
    ).toBe(204);

    let moved: { id: string; groupId: string; status: string } | undefined;
    for (let attempt = 0; attempt < 100 && !moved; attempt += 1) {
      const listed = (await http.request('GET', `${api}/groups/${kept.id}/settlements`, { token: ada.token })).body as {
        id: string;
        groupId: string;
        status: string;
      }[];
      moved = listed.find(settlement => settlement.id === settlementId);
      if (!moved) await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(moved).toMatchObject({ id: settlementId, groupId: kept.id, status: 'paid' });
  });
});
