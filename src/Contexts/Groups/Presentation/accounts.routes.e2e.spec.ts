import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The accounts, over HTTP: sign-up, sign-in, and reading one's own account, on a database file of its own. The
 * answers are held to the API `api/1-accounts.yaml` gives, through `apiClient()`.
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

const signUp = (body: Record<string, unknown>) => http.request('POST', `${api}/accounts`, { body });
const signIn = (body: Record<string, unknown>) => http.request('POST', `${api}/accounts/login`, { body });
const grace = { email: 'grace@example.org', password: 'analytical engine', name: 'Grace' };

describe('signing up', () => {
  it('creates the account and answers its id', async () => {
    const answer = await signUp(grace);
    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ id: expect.any(String) });
  });

  it('refuses an email already used, whatever its case', async () => {
    const answer = await signUp({ ...grace, email: 'GRACE@example.org' });
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ type: 'EmailAlreadyUsed', message: expect.any(String) });
  });

  it.each([
    ['an email that is not one', { email: 'grace' }],
    ['a password of 7 characters', { password: 'sevench' }],
    ['a name only of spaces', { name: '   ' }],
    ['a name of 61 characters', { name: 'a'.repeat(61) }],
  ])('refuses %s', async (_label, change) => {
    const answer = await signUp({ ...grace, email: `x${Math.random()}@example.org`, ...change });
    expect(answer.status).toBe(400);
  });

  it('refuses a body missing a field, or with a field of the wrong type, at once with 400', async () => {
    expect((await signUp({ email: 'a@example.org', password: 'long enough' })).status).toBe(400);
    expect((await signUp({ ...grace, email: 'n@example.org', password: 12345678 })).status).toBe(400);
  });
});

describe('signing in', () => {
  it('answers a token for the right password', async () => {
    await signUp({ email: 'ken@example.org', password: 'kernighan', name: 'Ken' });
    const answer = await signIn({ email: 'ken@example.org', password: 'kernighan' });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ token: expect.any(String) });
  });

  it('refuses a wrong password and an unknown email with the same answer', async () => {
    await signUp({ email: 'dennis@example.org', password: 'ritchie-1', name: 'Dennis' });
    const wrong = await signIn({ email: 'dennis@example.org', password: 'not-it-at-all' });
    const unknown = await signIn({ email: 'nobody@example.org', password: 'not-it-at-all' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });
});

describe('reading one’s own account', () => {
  it('answers the account of the token’s holder', async () => {
    const created = await signUp({ email: 'linus@example.org', password: 'torvalds!', name: 'Linus' });
    const { token } = (await signIn({ email: 'linus@example.org', password: 'torvalds!' })).body as { token: string };

    const answer = await http.get(`${api}/accounts/me`, { token });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      id: (created.body as { id: string }).id,
      email: 'linus@example.org',
      name: 'Linus',
    });
  });

  it('refuses a request with no token, or one that proves nothing, with 401', async () => {
    expect((await http.get(`${api}/accounts/me`)).status).toBe(401);
    expect((await http.get(`${api}/accounts/me`, { token: 'forged.token.value' })).status).toBe(401);
  });
});
