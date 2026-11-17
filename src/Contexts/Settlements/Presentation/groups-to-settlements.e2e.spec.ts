import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Groups → Settlements (ADR 10): Settlements asks Groups who the members of a group are, in the order they joined, through its
 * `ISettlementMembers` port, over Groups' read model. Over HTTP: a group made in Groups keeps the id its request answered, and
 * Settlements finds it by that id when a member asks for its suggested settlements, a member who joined later included; to
 * anyone who is not a member the group does not exist.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-groups-to-settlements-')), 'tally.sqlite');
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
  it('finds, by the id Groups answered, the group whose suggested settlements a member asks for, a member who joined later included', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');

    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ada.token,
    });
    expect(created.status).toBe(201);
    const { id: groupId } = created.body as { id: string };

    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token });
    const second = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token })).body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${second.id}/accept`, { token: linus.token });

    // Nothing is owed yet, so every member is even: Settlements finds the group by the id, and Linus, who joined last, is a member.
    const answer = await http.request('GET', `${api}/groups/${groupId}/settlements/suggested`, { token: linus.token });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([]);
  });

  it('answers a group to a non-member, and a group that is not there, as a group that does not exist', async () => {
    const ada = await signedInPerson('Ada');
    const outsider = await signedInPerson('Outsider');

    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ada.token,
    });
    const { id: groupId } = created.body as { id: string };

    const notAMember = await http.request('GET', `${api}/groups/${groupId}/settlements/suggested`, {
      token: outsider.token,
    });
    expect(notAMember.status).toBe(404);

    const notThere = await http.request('GET', `${api}/groups/no-such-group/settlements/suggested`, {
      token: ada.token,
    });
    expect(notThere.status).toBe(404);
  });
});
