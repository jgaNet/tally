import { Id } from '@Architecture/Domain';
import { ExecutionContext } from '@Architecture/Application';
import { InMemoryEventBus } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { EventEmitter } from 'events';
import { Email } from '@SharedKernel/Domain';
import { SignUpCommandEvent } from '@Contexts/Groups/Application/Commands/SignUp/SignUpCommandEvent';
import { SignUpCommandHandler } from '@Contexts/Groups/Application/Commands/SignUp/SignUpCommandHandler';
import { InMemoryAccountRepository } from '@Contexts/Groups/Infrastructure/InMemoryAccountRepository';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';

const context = () =>
  new ExecutionContext({
    traceId: 't',
    auth: {},
    eventBus: new InMemoryEventBus({ eventEmitter: new EventEmitter(), clock: systemClock }),
  });
const operation = (payload: { email: string; password: string; name: string }) => {
  const c = context();
  return { event: SignUpCommandEvent.set(payload) as SignUpCommandEvent, c };
};

describe('SignUpCommandHandler', () => {
  const hasher = new ScryptPasswordHasher();

  it('may be asked by anyone', () => {
    const handler = new SignUpCommandHandler(new InMemoryAccountRepository(), hasher);
    expect(handler.anyoneMayAsk()).toBe(true);
  });

  it('registers an account, keeps only the hash, and answers its id', async () => {
    const accounts = new InMemoryAccountRepository();
    const { event, c } = operation({ email: 'Alice@Example.com', password: 'correct horse', name: 'Alice' });
    const result = await new SignUpCommandHandler(accounts, hasher).execute(event, c);
    expect(result.isSuccess()).toBe(true);
    const stored = await accounts.findById(new Id(result.data as string));
    expect(stored?.email?.value).toBe('alice@example.com');
    expect(stored?.passwordHash).not.toContain('correct horse');
    expect(await hasher.verify('correct horse', stored?.passwordHash ?? '')).toBe(true);
    expect(await hasher.verify('wrong horse', stored?.passwordHash ?? '')).toBe(false);
  });

  it('refuses an email already used, whatever its case, and a value the domain refuses', async () => {
    const accounts = new InMemoryAccountRepository();
    const handler = new SignUpCommandHandler(accounts, hasher);
    const first = operation({ email: 'a@b.co', password: '12345678', name: 'A' });
    expect((await handler.execute(first.event, first.c)).isSuccess()).toBe(true);
    const again = operation({ email: 'A@B.CO', password: '12345678', name: 'B' });
    expect((await handler.execute(again.event, again.c)).error?.type).toBe('EmailAlreadyUsed');
    const short = operation({ email: 'c@d.co', password: '1234567', name: 'C' });
    expect((await handler.execute(short.event, short.c)).error?.type).toBe('InvalidPassword');
    expect(await accounts.findByEmail(Email.create('c@d.co').data as Email)).toBeNull();
  });
});
