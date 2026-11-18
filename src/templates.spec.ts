import type { Application } from './app';
import { send, signedUpAccount, startApplication, testDirectory, type TestDirectory } from './test-helpers';

describe('split templates', () => {
  let directory: TestDirectory;
  let app: Application;

  beforeEach(async () => {
    directory = testDirectory();
    app = await startApplication(directory.databaseUrl);
  });

  afterEach(async () => {
    await app.stop();
    await directory.remove();
  });

  /** A group of Bob (its owner), Cy and Dee, all members. */
  async function group() {
    const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
    const cy = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
    const dee = await signedUpAccount(app, { email: 'dee@example.com', name: 'Dee' });
    const created = await send(app, 'POST', '/groups', { token: bob.token, body: { name: 'Flat', currency: 'EUR' } });
    const groupId = idOf(created);
    for (const member of [cy, dee]) {
      const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: bob.token });
      await send(app, 'POST', `/invitations/${idOf(invitation)}/accept`, { token: member.token });
    }
    return { bob, cy, dee, groupId };
  }

  function idOf(reply: { body: unknown }): string {
    return (reply.body as { id: string }).id;
  }

  const save = (token: string, groupId: string, body: unknown) =>
    send(app, 'POST', `/groups/${groupId}/templates`, { token, body });

  async function recordExpense(token: string, groupId: string, body: Record<string, unknown>) {
    return send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      body: { description: 'Rent', amount: 1001, date: '2026-11-01', ...body },
    });
  }

  async function readExpense(token: string, expenseId: string) {
    const reply = await send(app, 'GET', `/expenses/${expenseId}`, { token });
    return reply.body as {
      version: number;
      amount: number;
      paidBy: string;
      splitKind: string;
      shares: { memberId: string; amount: number }[];
    };
  }

  it('saves a template and lists it to members, the earliest saved first, each with its split as given', async () => {
    const { bob, cy, dee, groupId } = await group();
    const first = await save(bob.token, groupId, { name: 'Flat', splitBetween: [bob.id, cy.id] });
    expect(first.status).toBe(201);
    const second = await save(cy.token, groupId, {
      name: 'Big room',
      splitByShares: [
        { memberId: bob.id, shares: 2 },
        { memberId: cy.id, shares: 1 },
      ],
    });
    expect(second.status).toBe(201);
    const read = await send(app, 'GET', `/groups/${groupId}/templates`, { token: dee.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual([
      { id: idOf(first), groupId, name: 'Flat', splitBetween: [bob.id, cy.id] },
      {
        id: idOf(second),
        groupId,
        name: 'Big room',
        splitByShares: [
          { memberId: bob.id, shares: 2 },
          { memberId: cy.id, shares: 1 },
        ],
      },
    ]);
  });

  it('answers the templates of a group to its members only, and a sign-in is needed', async () => {
    const { bob, groupId } = await group();
    const outsider = await signedUpAccount(app, { email: 'out@example.com' });
    await save(bob.token, groupId, { name: 'Flat', splitBetween: [bob.id] });
    expect((await send(app, 'GET', `/groups/${groupId}/templates`, { token: outsider.token })).status).toBe(404);
    expect((await save(outsider.token, groupId, { name: 'Mine', splitBetween: [outsider.id] })).status).toBe(404);
    expect((await send(app, 'GET', `/groups/${groupId}/templates`)).status).toBe(401);
    expect((await save(bob.token, groupId, { name: 'Flat', splitBetween: [bob.id] })).status).toBe(409);
  });

  it('checks the name: 1 to 60 characters, not only spaces, and unique in its group whatever its case', async () => {
    const { bob, groupId } = await group();
    const body = (name: string) => ({ name, splitBetween: [bob.id] });
    expect((await save(bob.token, groupId, body(''))).status).toBe(422);
    expect((await save(bob.token, groupId, body('   '))).status).toBe(422);
    expect((await save(bob.token, groupId, body('a'.repeat(61)))).status).toBe(422);
    expect((await save(bob.token, groupId, body('😀'.repeat(61)))).status).toBe(422);
    expect((await save(bob.token, groupId, body('a'.repeat(60)))).status).toBe(201);
    expect((await save(bob.token, groupId, body('😀'.repeat(60)))).status).toBe(201);

    expect((await save(bob.token, groupId, body('  Rent  '))).status).toBe(201);
    const listed = (await send(app, 'GET', `/groups/${groupId}/templates`, { token: bob.token })).body as {
      name: string;
    }[];
    expect(listed.map(template => template.name)).toContain('Rent');
    expect((await save(bob.token, groupId, body('Rent'))).status).toBe(409);
    expect((await save(bob.token, groupId, body('rent'))).status).toBe(409);
    expect((await save(bob.token, groupId, body('RENT'))).status).toBe(409);

    // Another group may have a template of the same name.
    const other = await send(app, 'POST', '/groups', { token: bob.token, body: { name: 'Villa', currency: 'EUR' } });
    expect((await save(bob.token, idOf(other), body('Rent'))).status).toBe(201);
  });

  it('checks the shape: exactly one of its two splits, members of the group each once, at least 1 share', async () => {
    const { bob, cy, groupId } = await group();
    const outsider = await signedUpAccount(app, { email: 'out@example.com' });
    const post = (body: unknown) => save(bob.token, groupId, body);
    expect((await post({ name: 'Nothing' })).status).toBe(400);
    expect((await post({ splitBetween: [bob.id] })).status).toBe(400);
    expect(
      (await post({ name: 'Both', splitBetween: [bob.id], splitByShares: [{ memberId: bob.id, shares: 1 }] })).status,
    ).toBe(400);
    expect((await post({ name: 'Exact', splitExactly: [{ memberId: bob.id, amount: 1 }] })).status).toBe(400);
    expect((await post({ name: 'Empty', splitBetween: [] })).status).toBe(422);
    expect((await post({ name: 'Twice', splitBetween: [bob.id, bob.id] })).status).toBe(422);
    expect((await post({ name: 'Outsider', splitBetween: [bob.id, outsider.id] })).status).toBe(422);
    expect((await post({ name: 'No share', splitByShares: [{ memberId: bob.id, shares: 0 }] })).status).toBe(422);
    expect((await post({ name: 'Half', splitByShares: [{ memberId: bob.id, shares: 1.5 }] })).status).toBe(422);
    expect(
      (
        await post({
          name: 'Shares',
          splitByShares: [
            { memberId: bob.id, shares: 1 },
            { memberId: cy.id, shares: 3 },
          ],
        })
      ).status,
    ).toBe(201);
  });

  it('replaces a template by the member who saved it or the owner, and removes it; another member is refused', async () => {
    const { bob, cy, dee, groupId } = await group();
    const outsider = await signedUpAccount(app, { email: 'out@example.com' });
    const flat = idOf(await save(cy.token, groupId, { name: 'Flat', splitBetween: [bob.id, cy.id] }));
    const villa = idOf(await save(bob.token, groupId, { name: 'Villa', splitBetween: [bob.id, cy.id, dee.id] }));
    const put = (token: string, id: string, body: unknown) => send(app, 'PUT', `/templates/${id}`, { token, body });

    expect((await put(dee.token, flat, { name: 'Flat', splitBetween: [dee.id] })).status).toBe(403);
    expect((await put(outsider.token, flat, { name: 'Flat', splitBetween: [dee.id] })).status).toBe(404);
    expect((await put(bob.token, 'no-such-template', { name: 'Flat', splitBetween: [dee.id] })).status).toBe(404);

    // Replaced whole, keeping its place in the order it was saved.
    expect(
      (await put(bob.token, flat, { name: 'Flat, renamed', splitByShares: [{ memberId: bob.id, shares: 3 }] })).status,
    ).toBe(204);
    expect((await put(cy.token, flat, { name: 'FLAT', splitBetween: [cy.id, dee.id] })).status).toBe(204);
    expect((await put(cy.token, flat, { name: 'Villa', splitBetween: [cy.id] })).status).toBe(409);
    expect((await put(cy.token, flat, { name: 'Flat', splitBetween: [] })).status).toBe(422);
    const listed = (await send(app, 'GET', `/groups/${groupId}/templates`, { token: bob.token })).body;
    expect(listed).toEqual([
      { id: flat, groupId, name: 'FLAT', splitBetween: [cy.id, dee.id] },
      { id: villa, groupId, name: 'Villa', splitBetween: [bob.id, cy.id, dee.id] },
    ]);

    const remove = (token: string, id: string) => send(app, 'DELETE', `/templates/${id}`, { token });
    expect((await remove(dee.token, villa)).status).toBe(403);
    expect((await remove(outsider.token, villa)).status).toBe(404);
    expect((await remove(bob.token, villa)).status).toBe(204);
    expect((await remove(bob.token, villa)).status).toBe(404);
    expect((await send(app, 'GET', `/groups/${groupId}/templates`, { token: bob.token })).body).toEqual([
      { id: flat, groupId, name: 'FLAT', splitBetween: [cy.id, dee.id] },
    ]);
  });

  it('splits an expense by a template as if its split had been given', async () => {
    const { bob, cy, groupId } = await group();
    const flat = idOf(await save(bob.token, groupId, { name: 'Flat', splitBetween: [bob.id, cy.id] }));
    const big = idOf(
      await save(bob.token, groupId, {
        name: 'Big room',
        splitByShares: [
          { memberId: bob.id, shares: 1 },
          { memberId: cy.id, shares: 2 },
        ],
      }),
    );

    const equal = await recordExpense(bob.token, groupId, { template: flat });
    expect(equal.status).toBe(201);
    const equalExpense = await readExpense(cy.token, idOf(equal));
    expect(equalExpense).toMatchObject({
      amount: 1001,
      paidBy: bob.id,
      splitKind: 'equal',
      shares: [
        { memberId: bob.id, amount: 501 },
        { memberId: cy.id, amount: 500 },
      ],
    });

    const shares = await recordExpense(cy.token, groupId, { amount: 1000, template: big });
    expect(shares.status).toBe(201);
    expect(await readExpense(bob.token, idOf(shares))).toMatchObject({
      amount: 1000,
      paidBy: cy.id,
      splitKind: 'shares',
      shares: [
        { memberId: bob.id, amount: 334 },
        { memberId: cy.id, amount: 666 },
      ],
    });

    // The same expense, given its split itself, is the same expense.
    const given = idOf(await recordExpense(bob.token, groupId, { splitBetween: [bob.id, cy.id] }));
    const givenExpense = await readExpense(bob.token, given);
    expect(givenExpense).toMatchObject({ splitKind: equalExpense.splitKind, shares: equalExpense.shares });
  });

  it('keeps the shares of an expense when its template is changed or removed later', async () => {
    const { bob, cy, groupId } = await group();
    const flat = idOf(await save(bob.token, groupId, { name: 'Flat', splitBetween: [bob.id, cy.id] }));
    const expenseId = idOf(await recordExpense(bob.token, groupId, { template: flat }));
    const before = await readExpense(bob.token, expenseId);

    expect(
      (
        await send(app, 'PUT', `/templates/${flat}`, {
          token: bob.token,
          body: { name: 'Solo', splitBetween: [bob.id] },
        })
      ).status,
    ).toBe(204);
    expect(await readExpense(bob.token, expenseId)).toEqual(before);
    expect((await send(app, 'DELETE', `/templates/${flat}`, { token: bob.token })).status).toBe(204);
    expect(await readExpense(bob.token, expenseId)).toEqual(before);
  });

  it('edits an expense to be split by a template, from the version read', async () => {
    const { bob, cy, groupId } = await group();
    const big = idOf(
      await save(bob.token, groupId, {
        name: 'Big room',
        splitByShares: [
          { memberId: bob.id, shares: 1 },
          { memberId: cy.id, shares: 2 },
        ],
      }),
    );
    const expenseId = idOf(await recordExpense(bob.token, groupId, { amount: 1000, splitBetween: [bob.id, cy.id] }));
    const edit = (version: number) =>
      send(app, 'PUT', `/expenses/${expenseId}`, {
        token: bob.token,
        body: { description: 'Rent', amount: 1000, date: '2026-11-01', template: big, version },
      });

    const edited = await edit(1);
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      version: 2,
      splitKind: 'shares',
      shares: [
        { memberId: bob.id, amount: 334 },
        { memberId: cy.id, amount: 666 },
      ],
    });
    expect((await edit(1)).status).toBe(409);
  });

  it('refuses an expense split by a template that does not fit: a left member, a payer left out, another group', async () => {
    const { bob, cy, dee, groupId } = await group();
    const other = idOf(
      await send(app, 'POST', '/groups', { token: bob.token, body: { name: 'Villa', currency: 'EUR' } }),
    );
    const elsewhere = idOf(await save(bob.token, other, { name: 'Villa', splitBetween: [bob.id] }));
    const withCy = idOf(await save(bob.token, groupId, { name: 'Cy and Dee', splitBetween: [cy.id, dee.id] }));
    const withBob = idOf(await save(bob.token, groupId, { name: 'With Bob', splitBetween: [bob.id, cy.id] }));

    // The payer is not among the members of the template.
    expect((await recordExpense(bob.token, groupId, { template: withCy })).status).toBe(422);
    // A template of another group, or none of the group's.
    expect((await recordExpense(bob.token, groupId, { template: elsewhere })).status).toBe(422);
    expect((await recordExpense(bob.token, groupId, { template: 'no-such-template' })).status).toBe(422);

    // A member of the template who has left the group: the expense is refused, as an edit of one is.
    const left = await send(app, 'POST', `/groups/${groupId}/leave`, { token: cy.token });
    expect(left.status).toBe(204);
    expect((await recordExpense(bob.token, groupId, { template: withBob })).status).toBe(422);
    const expenseId = idOf(await recordExpense(bob.token, groupId, { splitBetween: [bob.id, dee.id] }));
    const edited = await send(app, 'PUT', `/expenses/${expenseId}`, {
      token: bob.token,
      body: { description: 'Rent', amount: 1001, date: '2026-11-01', template: withBob, version: 1 },
    });
    expect(edited.status).toBe(422);
    expect((await readExpense(bob.token, expenseId)).version).toBe(1);
  });

  it('takes exactly one of the three splits and a template', async () => {
    const { bob, cy, groupId } = await group();
    const flat = idOf(await save(bob.token, groupId, { name: 'Flat', splitBetween: [bob.id, cy.id] }));
    expect((await recordExpense(bob.token, groupId, { template: flat, splitBetween: [bob.id] })).status).toBe(400);
    expect(
      (await recordExpense(bob.token, groupId, { template: flat, splitByShares: [{ memberId: bob.id, shares: 1 }] }))
        .status,
    ).toBe(400);
    expect(
      (await recordExpense(bob.token, groupId, { description: 'Rent', amount: 1001, date: '2026-11-01' })).status,
    ).toBe(400);
    expect((await recordExpense(bob.token, groupId, { template: flat })).status).toBe(201);
  });
});
