import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { EventBus, ExecutionContext } from '@Architecture/Application';
import { InMemoryGroupStore } from '@Contexts/Groups/Infrastructure/InMemoryGroupStore';
import { createGroup, getGroup, getMyGroups } from '@Contexts/Groups/Application/Groups';

/** The use cases of the groups, over the in-memory store: what each one does to the store, and what a member sees. */
const now = new Date('2026-05-01T10:00:00.000Z');
const clock = () => now;

let store: InMemoryGroupStore;
let context: (auth?: { subjectId?: string; role?: string }) => ExecutionContext;

beforeEach(() => {
  store = new InMemoryGroupStore();
  const eventBus = { connect: jest.fn(), publish: jest.fn(), subscribe: jest.fn() } as unknown as EventBus;
  context = (auth = {}) => new ExecutionContext({ traceId: 'trace', eventBus, auth });
  ann = context({ subjectId: 'account-ann', role: 'USER' });
  bob = context({ subjectId: 'account-bob', role: 'USER' });
});

let ann: ExecutionContext;
let bob: ExecutionContext;

describe('createGroup', () => {
  it('keeps the group with its owner as its only member, and answers its id', async () => {
    const result = await createGroup(store, clock).run({ name: 'Flat', currency: 'EUR' }, ann);

    expect(result.isSuccess()).toBe(true);
    expect(store.groups.get(result.data!)).toMatchObject({
      name: 'Flat',
      currency: 'EUR',
      ownerId: 'account-ann',
      memberIds: ['account-ann'],
    });
  });

  it('refuses what the domain refuses, and keeps nothing', async () => {
    expect((await createGroup(store, clock).run({ name: 'Flat', currency: 'JPY' }, ann)).isFailure()).toBe(true);
    expect((await createGroup(store, clock).run({ name: '  ', currency: 'EUR' }, ann)).isFailure()).toBe(true);
    expect(store.groups.size).toBe(0);
  });
});

describe('getGroup', () => {
  it('answers the group to its member, and does not answer it to anyone else', async () => {
    const { data: id } = await createGroup(store, clock).run({ name: 'Flat', currency: 'USD' }, ann);

    expect((await getGroup(store).run(id!, ann)).data).toEqual({
      id,
      name: 'Flat',
      currency: 'USD',
      ownerId: 'account-ann',
    });

    const stranger = await getGroup(store).run(id!, bob);
    const unknown = await getGroup(store).run('no-such-group', ann);
    expect(stranger.isFailure() && stranger.error.type).toBe('NotFound');
    expect(unknown.isFailure() && unknown.error.type).toBe('NotFound');
  });
});

describe('getMyGroups', () => {
  it('lists the groups the person is a member of, the most recently created first', async () => {
    const first = (await createGroup(store, clock).run({ name: 'First', currency: 'EUR' }, ann)).data!;
    const second = (await createGroup(store, clock).run({ name: 'Second', currency: 'EUR' }, ann)).data!;
    await createGroup(store, clock).run({ name: 'Bob only', currency: 'EUR' }, bob);

    const mine = await getMyGroups(store).run(undefined, ann);
    expect(mine.data!.map(group => group.id)).toEqual([second, first]);
  });

  it('answers an empty list to a person who is in no group', async () => {
    expect((await getMyGroups(store).run(undefined, ann)).data).toEqual([]);
  });
});
