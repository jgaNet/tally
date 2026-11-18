import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabasePath } from '../test-support';

describe('split templates', () => {
  let app: Application;

  beforeEach(async () => {
    app = await createApplication({ databasePath: temporaryDatabasePath() });
  });

  afterEach(async () => {
    await app.stop();
  });

  async function setup() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const outsider = await signedUpAccount(app, { email: 'out@example.com', name: 'Out' });
    const created = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    return { ada, grace, outsider, groupId };
  }

  const save = (token: string, groupId: string, payload: object) =>
    send(app, 'POST', `/groups/${groupId}/templates`, { token, payload });

  const replace = (token: string, templateId: string, payload: object) =>
    send(app, 'PUT', `/templates/${templateId}`, { token, payload });

  async function savedId(token: string, groupId: string, payload: object): Promise<string> {
    const response = await save(token, groupId, payload);
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function templatesOf(token: string, groupId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/templates`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<unknown[]>();
  }

  it('saves a template, answering its id, and lists it with its split as it was given', async () => {
    const { ada, grace, groupId } = await setup();
    const id = await savedId(ada.token, groupId, { name: 'Flat', splitBetween: [ada.id, grace.id] });

    expect(await templatesOf(grace.token, groupId)).toEqual([
      { id, groupId, name: 'Flat', splitBetween: [ada.id, grace.id] },
    ]);
  });

  it('lists the templates of a group the earliest saved first', async () => {
    const { ada, grace, groupId } = await setup();
    const rent = await savedId(ada.token, groupId, {
      name: 'Rent',
      splitByShares: [
        { memberId: ada.id, shares: 2 },
        { memberId: grace.id, shares: 1 },
      ],
    });
    const food = await savedId(grace.token, groupId, { name: 'Food', splitBetween: [grace.id, ada.id] });
    const bills = await savedId(ada.token, groupId, { name: 'Bills', splitBetween: [ada.id] });

    const listed = (await templatesOf(ada.token, groupId)) as { id: string }[];
    expect(listed.map(template => template.id)).toEqual([rent, food, bills]);
    expect(listed[0]).toEqual({
      id: rent,
      groupId,
      name: 'Rent',
      splitByShares: [
        { memberId: ada.id, shares: 2 },
        { memberId: grace.id, shares: 1 },
      ],
    });
  });

  it('keeps a name as given, trimmed, of 1 to 60 characters, not only spaces', async () => {
    const { ada, groupId } = await setup();
    const trimmed = await savedId(ada.token, groupId, { name: '  Weekly  ', splitBetween: [ada.id] });
    expect((await templatesOf(ada.token, groupId)) as { id: string; name: string }[]).toEqual([
      { id: trimmed, groupId, name: 'Weekly', splitBetween: [ada.id] },
    ]);

    const longest = 'é'.repeat(60);
    expect((await save(ada.token, groupId, { name: longest, splitBetween: [ada.id] })).statusCode).toBe(201);

    for (const name of ['', '   ', 'é'.repeat(61)]) {
      const response = await save(ada.token, groupId, { name, splitBetween: [ada.id] });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ type: 'InvalidName', message: expect.any(String) });
    }
    expect(await templatesOf(ada.token, groupId)).toHaveLength(2);
  });

  it('refuses a name another template of the group has, whatever its case, and allows it in another group', async () => {
    const { ada, grace, groupId } = await setup();
    await savedId(ada.token, groupId, { name: 'Flat', splitBetween: [ada.id, grace.id] });

    const again = await save(grace.token, groupId, { name: 'FLAT ', splitBetween: [ada.id] });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ type: 'NameTaken', message: expect.any(String) });

    const other = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Office', currency: 'EUR' },
    });
    const otherGroupId = other.json<{ id: string }>().id;
    expect((await save(ada.token, otherGroupId, { name: 'flat', splitBetween: [ada.id] })).statusCode).toBe(201);
  });

  it('refuses a split that is neither of the two, or both, as the wrong shape', async () => {
    const { ada, grace, groupId } = await setup();
    const shapes = [
      { name: 'None' },
      { name: 'Both', splitBetween: [ada.id], splitByShares: [{ memberId: grace.id, shares: 1 }] },
      { name: 'Exact', splitExactly: [{ memberId: ada.id, amount: 1000 }] },
      { name: 'Exact too', splitBetween: [ada.id], splitExactly: [{ memberId: ada.id, amount: 1000 }] },
    ];
    for (const payload of shapes) {
      const response = await save(ada.token, groupId, payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ type: 'InvalidBody', message: expect.any(String) });
    }
    expect(await templatesOf(ada.token, groupId)).toEqual([]);
  });

  it('refuses a split whose members are not all members of the group, or are listed twice, or none', async () => {
    const { ada, grace, outsider, groupId } = await setup();

    const notMember = await save(ada.token, groupId, { name: 'Stray', splitBetween: [ada.id, outsider.id] });
    expect(notMember.statusCode).toBe(422);
    expect(notMember.json()).toEqual({ type: 'NotAMember', message: expect.any(String) });

    const twice = await save(ada.token, groupId, { name: 'Twice', splitBetween: [ada.id, ada.id] });
    expect(twice.statusCode).toBe(422);
    expect(twice.json()).toEqual({ type: 'InvalidSplit', message: expect.any(String) });

    const nobody = await save(ada.token, groupId, { name: 'Nobody', splitBetween: [] });
    expect(nobody.statusCode).toBe(422);
    expect(nobody.json()).toEqual({ type: 'InvalidSplit', message: expect.any(String) });

    const noShares = await save(ada.token, groupId, {
      name: 'Zero',
      splitByShares: [
        { memberId: ada.id, shares: 0 },
        { memberId: grace.id, shares: 1 },
      ],
    });
    expect(noShares.statusCode).toBe(422);
    expect(noShares.json()).toEqual({ type: 'InvalidShares', message: expect.any(String) });

    expect(await templatesOf(ada.token, groupId)).toEqual([]);
  });

  it('lets the member who saved a template, or the owner, replace it, keeping its place, and refuses any other member', async () => {
    const { ada, grace, groupId } = await setup();
    const first = await savedId(ada.token, groupId, { name: 'First', splitBetween: [ada.id] });
    const second = await savedId(grace.token, groupId, { name: 'Second', splitBetween: [grace.id] });

    expect((await replace(grace.token, first, { name: 'Mine', splitBetween: [grace.id] })).statusCode).toBe(403);
    expect((await replace(ada.token, second, { name: 'Theirs', splitBetween: [ada.id] })).statusCode).toBe(204);
    expect(
      (await replace(ada.token, first, { name: 'Replaced', splitByShares: [{ memberId: ada.id, shares: 3 }] }))
        .statusCode,
    ).toBe(204);

    expect(await templatesOf(grace.token, groupId)).toEqual([
      { id: first, groupId, name: 'Replaced', splitByShares: [{ memberId: ada.id, shares: 3 }] },
      { id: second, groupId, name: 'Theirs', splitBetween: [ada.id] },
    ]);
  });

  it('removes a template, by its author or the owner, and refuses any other member', async () => {
    const { ada, grace, groupId } = await setup();
    // The owner may remove a template another member saved.
    const graces = await savedId(grace.token, groupId, { name: 'Grace', splitBetween: [grace.id] });
    expect((await send(app, 'DELETE', `/templates/${graces}`, { token: ada.token })).statusCode).toBe(204);

    // Its author may remove it too.
    const own = await savedId(grace.token, groupId, { name: 'Own', splitBetween: [grace.id] });
    expect((await send(app, 'DELETE', `/templates/${own}`, { token: grace.token })).statusCode).toBe(204);
    expect(await templatesOf(ada.token, groupId)).toEqual([]);

    // Any other member may not.
    const adas = await savedId(ada.token, groupId, { name: 'Ada', splitBetween: [ada.id] });
    expect((await send(app, 'DELETE', `/templates/${adas}`, { token: grace.token })).statusCode).toBe(403);
    expect(await templatesOf(ada.token, groupId)).toHaveLength(1);
  });

  it('answers a template that does not exist, or a member who is not in its group, as not there', async () => {
    const { ada, outsider, groupId } = await setup();
    const id = await savedId(ada.token, groupId, { name: 'Flat', splitBetween: [ada.id] });

    const replaced = await replace(outsider.token, id, { name: 'Mine', splitBetween: [outsider.id] });
    expect(replaced.statusCode).toBe(404);
    expect(replaced.json()).toEqual({ type: 'NotFound', message: expect.any(String) });
    expect((await send(app, 'DELETE', `/templates/${id}`, { token: outsider.token })).statusCode).toBe(404);
    expect((await send(app, 'DELETE', `/templates/${id}`, { token: ada.token })).statusCode).toBe(204);
    expect((await send(app, 'DELETE', `/templates/${id}`, { token: ada.token })).statusCode).toBe(404);
    expect((await replace(ada.token, id, { name: 'Gone', splitBetween: [ada.id] })).statusCode).toBe(404);
  });

  it('refuses a replacement whose name another template has, and keeps its own name', async () => {
    const { ada, grace, groupId } = await setup();
    await savedId(ada.token, groupId, { name: 'Rent', splitBetween: [ada.id] });
    const food = await savedId(ada.token, groupId, { name: 'Food', splitBetween: [ada.id] });

    const clash = await replace(ada.token, food, { name: 'RENT', splitBetween: [ada.id] });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toEqual({ type: 'NameTaken', message: expect.any(String) });

    expect((await replace(ada.token, food, { name: 'food', splitBetween: [ada.id, grace.id] })).statusCode).toBe(204);
    expect(
      (await templatesOf(ada.token, groupId)).map((template: unknown) => (template as { name: string }).name),
    ).toEqual(['Rent', 'food']);
  });

  it('reads the templates of a group to its members only', async () => {
    const { ada, outsider, groupId } = await setup();
    await savedId(ada.token, groupId, { name: 'Flat', splitBetween: [ada.id] });

    const read = await send(app, 'GET', `/groups/${groupId}/templates`, { token: outsider.token });
    expect(read.statusCode).toBe(404);
    expect((await save(outsider.token, groupId, { name: 'Mine', splitBetween: [outsider.id] })).statusCode).toBe(404);
  });
});
