import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Request 32 over HTTP: Ann and Bob net what they owe each other across the groups they share, as settlements that count at once; the
 * netting is read by the two of them only; a netting that nets nothing, with oneself, or in an unknown currency is refused and changes nothing;
 * two nettings at once keep one; and the settlements it made are in the audit and the statement, as by netting.
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

/** A group of `owner` with `other` joined, in `currency`. */
async function groupOf(owner: { token: string }, other: { token: string }, name: string, currency = 'EUR') {
  const { id: groupId } = (
    await http.request('POST', `${api}/groups`, { body: { name, currency }, token: owner.token })
  ).body as { id: string };
  const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token }))
    .body as { id: string };
  await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: other.token });
  return groupId;
}

/** The expense of `amount`, paid by `payer`, split equally between Ann and Bob. */
async function expense(groupId: string, payer: { token: string }, amount: number, ann: string, bob: string) {
  await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Shared', amount, date: '2020-01-15', splitBetween: [ann, bob] },
    token: payer.token,
  });
}

const balancesOf = async (groupId: string, token: string) =>
  (
    (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body as {
      memberId: string;
      balance: number;
    }[]
  ).reduce<Record<string, number>>((all, row) => ({ ...all, [row.memberId]: row.balance }), {});

/**
 * Ann owes Bob 300 in the flat and 200 in the trip, created later; Bob owes Ann 400 in the club (request 32's example).
 */
async function annAndBobAcrossThreeGroups() {
  const ann = await signedInPerson('Ann');
  const bob = await signedInPerson('Bob');
  const zed = await signedInPerson('Zed');
  const flat = await groupOf(ann, bob, 'Flat');
  await expense(flat, bob, 600, ann.id, bob.id);
  const trip = await groupOf(ann, bob, 'Trip');
  await expense(trip, bob, 400, ann.id, bob.id);
  const club = await groupOf(bob, ann, 'Club');
  await expense(club, ann, 800, ann.id, bob.id);
  return { ann, bob, zed, flat, trip, club };
}

describe('Netting across groups (request 32)', () => {
  it('nets 400 of what Ann and Bob owe each other, as settlements that count at once, and reads it to the two of them only', async () => {
    const { ann, bob, zed, flat, trip, club } = await annAndBobAcrossThreeGroups();

    const netted = await http.request('POST', `${api}/nettings`, {
      body: { with: bob.id, currency: 'EUR' },
      token: ann.token,
    });
    expect(netted.status).toBe(201);
    const { id } = netted.body as { id: string };

    const read = await http.request('GET', `${api}/nettings/${id}`, { token: bob.token });
    expect(read.status).toBe(200);
    const { settlements } = read.body as { settlements: string[] };
    expect(read.body).toEqual({
      id,
      by: ann.id,
      with: bob.id,
      currency: 'EUR',
      amount: 400,
      settlements: [expect.any(String), expect.any(String), expect.any(String)],
    });

    const made = await Promise.all(
      settlements.map(
        async settlementId =>
          (await http.request('GET', `${api}/settlements/${settlementId}`, { token: ann.token })).body as {
            groupId: string;
            from: string;
            to: string;
            amount: number;
            method: string;
            status: string;
          },
      ),
    );
    expect(
      made.map(({ groupId, from, to, amount, method, status }) => ({ groupId, from, to, amount, method, status })),
    ).toEqual([
      { groupId: flat, from: ann.id, to: bob.id, amount: 300, method: 'net', status: 'paid' },
      { groupId: trip, from: ann.id, to: bob.id, amount: 100, method: 'net', status: 'paid' },
      { groupId: club, from: bob.id, to: ann.id, amount: 400, method: 'net', status: 'paid' },
    ]);

    // Counted at once: Ann still owes 100 in the trip, and the club is square.
    expect(await balancesOf(trip, ann.token)).toEqual({ [ann.id]: -100, [bob.id]: 100 });
    expect(await balancesOf(club, bob.token)).toEqual({ [ann.id]: 0, [bob.id]: 0 });

    // Zed, who is in none of the groups, does not see it.
    expect((await http.request('GET', `${api}/nettings/${id}`, { token: zed.token })).status).toBe(404);
  });

  it('keeps who asked in the audit, and names each settlement by netting in the statement', async () => {
    const { ann, bob, flat } = await annAndBobAcrossThreeGroups();
    await http.request('POST', `${api}/nettings`, { body: { with: bob.id, currency: 'EUR' }, token: ann.token });

    const audit = (await http.request('GET', `${api}/groups/${flat}/audit`, { token: ann.token })).body as {
      action: string;
      by: string;
      amount: number;
    }[];
    expect(audit.filter(line => line.action === 'settlement-paid' && line.amount === 300)).toEqual([
      expect.objectContaining({ action: 'settlement-paid', by: ann.id, amount: 300 }),
    ]);

    const statement = (
      await http.request('GET', `${api}/groups/${flat}/members/${ann.id}/statement`, { token: ann.token })
    ).body as { entries: { kind: string; description?: string }[] };
    expect(statement.entries.filter(entry => entry.kind === 'settlement').map(entry => entry.description)).toEqual([
      'Settlement by netting',
    ]);
  });

  it('refuses a netting with oneself, in an unknown currency, or with nothing to net, and a body of the wrong shape or no caller', async () => {
    const { ann, bob, zed } = await annAndBobAcrossThreeGroups();
    const net = (token: string | undefined, body: unknown) => http.request('POST', `${api}/nettings`, { body, token });

    const self = await net(ann.token, { with: ann.id, currency: 'EUR' });
    expect(self.status).toBe(400);
    expect(self.body).toMatchObject({ type: 'NettingWithSelf' });

    const unknown = await net(ann.token, { with: bob.id, currency: 'XYZ' });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ type: 'NettingCurrencyUnknown' });

    expect((await net(ann.token, { with: bob.id })).status).toBe(400);
    expect((await net(undefined, { with: bob.id, currency: 'EUR' })).status).toBe(401);

    // With someone with nothing to net: Zed shares no group with Ann.
    const nothing = await net(ann.token, { with: zed.id, currency: 'EUR' });
    expect(nothing.status).toBe(400);
    expect(nothing.body).toMatchObject({ type: 'NothingToNet' });
  });

  it('nets nothing a second time: the settlements of the first leave nothing to net, and the second is refused', async () => {
    const { ann, bob } = await annAndBobAcrossThreeGroups();
    const first = await http.request('POST', `${api}/nettings`, {
      body: { with: bob.id, currency: 'EUR' },
      token: ann.token,
    });
    expect(first.status).toBe(201);
    const again = await http.request('POST', `${api}/nettings`, {
      body: { with: bob.id, currency: 'EUR' },
      token: ann.token,
    });
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({ type: 'NothingToNet' });
  });

  it('keeps one of two nettings asked at the same moment, and refuses the other, each netting all or nothing', async () => {
    const { ann, bob, flat, trip, club } = await annAndBobAcrossThreeGroups();
    const net = () =>
      http.request('POST', `${api}/nettings`, { body: { with: bob.id, currency: 'EUR' }, token: ann.token });

    const [first, second] = await Promise.all([net(), net()]);
    expect([first.status, second.status].sort()).toEqual([201, 400]);
    expect(await balancesOf(flat, ann.token)).toEqual({ [ann.id]: 0, [bob.id]: 0 });
    expect(await balancesOf(trip, ann.token)).toEqual({ [ann.id]: -100, [bob.id]: 100 });
    expect(await balancesOf(club, bob.token)).toEqual({ [ann.id]: 0, [bob.id]: 0 });
  });

  it('refuses a refund of a netted settlement, which moves no money to refund', async () => {
    const { ann, bob, flat } = await annAndBobAcrossThreeGroups();
    const netted = (
      await http.request('POST', `${api}/nettings`, { body: { with: bob.id, currency: 'EUR' }, token: ann.token })
    ).body as { id: string };
    const { settlements } = (await http.request('GET', `${api}/nettings/${netted.id}`, { token: ann.token })).body as {
      settlements: string[];
    };
    const inFlat = (
      await Promise.all(
        settlements.map(
          async id =>
            (await http.request('GET', `${api}/settlements/${id}`, { token: bob.token })).body as {
              groupId: string;
              id: string;
            },
        ),
      )
    ).find(settlement => settlement.groupId === flat)!;
    const refund = await http.request('POST', `${api}/settlements/${inFlat.id}/refund`, { token: bob.token });
    expect(refund.status).toBe(400);
  });
});

describe('Groups → Settlements', () => {
  it('nets between two members of a group made in Groups, which keeps the id its request answered, and finds the settlements in that group by it', async () => {
    const ann = await signedInPerson('Ann');
    const bob = await signedInPerson('Bob');
    const madeInGroups = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ann.token,
    });
    const { id: groupId } = madeInGroups.body as { id: string };
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: bob.token });
    await expense(groupId, bob, 600, ann.id, bob.id);
    const club = await groupOf(bob, ann, 'Club');
    await expense(club, ann, 800, ann.id, bob.id);

    const netted = await http.request('POST', `${api}/nettings`, {
      body: { with: bob.id, currency: 'EUR' },
      token: ann.token,
    });
    const { id } = netted.body as { id: string };
    const { settlements } = (await http.request('GET', `${api}/nettings/${id}`, { token: ann.token })).body as {
      settlements: string[];
    };
    const [settlement] = settlements;
    expect((await http.request('GET', `${api}/settlements/${settlement}`, { token: bob.token })).body).toMatchObject({
      groupId,
      from: ann.id,
      to: bob.id,
      amount: 300,
      method: 'net',
      status: 'paid',
    });
  });
});

describe('Ledger → Settlements', () => {
  it('nets what the expenses Ledger recorded leave owed, by the group id Ledger answered, and the netting counts the balances Ledger gives', async () => {
    const { ann, bob, flat, trip, club } = await annAndBobAcrossThreeGroups();
    const netted = (
      await http.request('POST', `${api}/nettings`, { body: { with: bob.id, currency: 'EUR' }, token: ann.token })
    ).body as { id: string };
    const { settlements } = (await http.request('GET', `${api}/nettings/${netted.id}`, { token: ann.token })).body as {
      settlements: string[];
    };
    const made = await Promise.all(
      settlements.map(
        async id =>
          (await http.request('GET', `${api}/settlements/${id}`, { token: ann.token })).body as {
            groupId: string;
            amount: number;
          },
      ),
    );
    expect(made.map(({ groupId, amount }) => ({ groupId, amount }))).toEqual([
      { groupId: flat, amount: 300 },
      { groupId: trip, amount: 100 },
      { groupId: club, amount: 400 },
    ]);
    expect(await balancesOf(flat, ann.token)).toEqual({ [ann.id]: 0, [bob.id]: 0 });
  });
});

describe('Settlements → Ledger', () => {
  it("records the settlements of a netting as Ledger counts them, and Ledger's statement names each by the id the netting answered", async () => {
    const { ann, bob, flat } = await annAndBobAcrossThreeGroups();
    const netted = (
      await http.request('POST', `${api}/nettings`, { body: { with: bob.id, currency: 'EUR' }, token: ann.token })
    ).body as { id: string };
    const { settlements } = (await http.request('GET', `${api}/nettings/${netted.id}`, { token: ann.token })).body as {
      settlements: string[];
    };
    const statement = (
      await http.request('GET', `${api}/groups/${flat}/members/${ann.id}/statement`, { token: ann.token })
    ).body as { entries: { kind: string; settlementId?: string; description?: string }[] };
    const settlementEntries = statement.entries.filter(entry => entry.kind === 'settlement');
    expect(settlementEntries).toEqual([
      expect.objectContaining({ settlementId: settlements[0], description: 'Settlement by netting' }),
    ]);
  });
});
