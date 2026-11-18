import { expect, jest } from '@jest/globals';

import { EventBus, ExecutionContext } from '@Architecture/Application';
import { Id } from '@Architecture/Domain';
import { Email, Role } from '@SharedKernel/Domain';

import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { Name } from '@Contexts/Groups/Domain/Account/Name';
import { DeleteAccountCommandEvent } from '@Contexts/Groups/Application/Commands/DeleteAccount/DeleteAccountCommandEvent';
import { DeleteAccountCommandHandler } from '@Contexts/Groups/Application/Commands/DeleteAccount/DeleteAccountCommandHandler';
import { InMemoryAccountReadModels, InMemoryAccountRepository } from '@Contexts/Groups/Infrastructure/InMemoryAccounts';
import { InMemoryGroupRepository, InMemoryWaitingPayments } from '@Contexts/Groups/Infrastructure/InMemoryGroups';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';

const eventBus = { connect: jest.fn(), publish: jest.fn(), subscribe: jest.fn() } as EventBus;
const at = new Date('2026-04-01T10:00:00.000Z');
const signedInAs = (subjectId: string) =>
  new ExecutionContext({ traceId: 'trace', eventBus, auth: { subjectId, role: Role.USER } });
const anonymous = () => new ExecutionContext({ traceId: 'trace', eventBus, auth: { role: Role.GUEST } });

const setup = async () => {
  const accountStore = new Map();
  const accounts = new InMemoryAccountRepository(accountStore);
  const account = Account.register({
    email: Email.create('cy@example.com').data as Email,
    name: Name.create('Cy').data as Name,
    passwordHash: 'hash',
  });
  await accounts.save(account);
  const groupStore = new Map();
  const groups = new InMemoryGroupRepository(groupStore);
  const waiting = new InMemoryWaitingPayments();
  const erased: unknown[] = [];
  const handler = new DeleteAccountCommandHandler(
    accounts,
    groups,
    waiting,
    { erase: async held => void erased.push(held) },
    () => at,
  );
  return {
    handler,
    accounts,
    groups,
    waiting,
    erased,
    readModels: new InMemoryAccountReadModels(accountStore),
    id: account._id.value,
  };
};

describe('DeleteAccount', () => {
  it('deletes the caller’s account, erases what a sign-up left, and leaves nobody to sign in with it', async () => {
    const { handler, accounts, readModels, erased, id } = await setup();

    const result = await handler.execute(DeleteAccountCommandEvent.set({}), signedInAs(id));

    expect(result.isSuccess()).toBe(true);
    const kept = await accounts.findById(new Id(id));
    expect(kept?.isDeleted()).toBe(true);
    expect(await accounts.findByEmail(Email.create('cy@example.com').data as Email)).toBeNull();
    expect(await readModels.findById(id)).toBeNull();
    expect(await readModels.isDeleted(id)).toBe(true);
    expect(erased).toEqual([{ accountId: id, email: 'cy@example.com' }]);
  });

  it('is refused while a payment it pays or receives waits at the provider', async () => {
    const { handler, accounts, waiting, id } = await setup();
    waiting.wait('lisbon', id);

    const result = await handler.execute(DeleteAccountCommandEvent.set({}), signedInAs(id));

    expect(result.isFailure() && result.error.type).toBe('PaymentWaitingAtTheProvider');
    expect((await accounts.findById(new Id(id)))?.isDeleted()).toBe(false);
  });

  const lisbon = (ownerId: string) =>
    Group.create({
      name: GroupName.create('Lisbon').data as GroupName,
      currency: Currency.create('EUR').data as Currency,
      ownerId: new Id(ownerId),
      now: at,
    });

  it('is refused while it owns a group another member is in, and nothing changes', async () => {
    const { handler, accounts, groups, id } = await setup();
    const group = lisbon(id);
    group.join({ accountId: new Id('ann'), now: at });
    await groups.save(group);

    const refused = await handler.execute(DeleteAccountCommandEvent.set({}), signedInAs(id));

    expect(refused.isFailure() && refused.error.type).toBe('OwnsAGroupWithOtherMembers');
    expect((await accounts.findById(new Id(id)))?.isDeleted()).toBe(false);
  });

  it('is allowed while it is alone in the group it owns, or only a member of another', async () => {
    const { handler, groups, id } = await setup();
    await groups.save(lisbon(id));
    const others = lisbon('ann');
    others.join({ accountId: new Id(id), now: at });
    await groups.save(others);

    expect((await handler.execute(DeleteAccountCommandEvent.set({}), signedInAs(id))).isSuccess()).toBe(true);
  });

  it('may not be asked by anyone who is not signed in', async () => {
    const { handler } = await setup();

    expect(handler.anyoneMayAsk(DeleteAccountCommandEvent.set({}))).toBe(false);
    expect((await handler.execute(DeleteAccountCommandEvent.set({}), anonymous())).isFailure()).toBe(true);
  });
});
