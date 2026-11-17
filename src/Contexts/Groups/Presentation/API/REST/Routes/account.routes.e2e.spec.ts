import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});

afterAll(() => app.stop());

type Body = Record<string, unknown>;

/** Follows an operation to its outcome, as a client does. */
async function outcome(operationId: string, token?: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    if (status !== 200 || (body as Body).status !== 'PENDING') return { status, body: body as Body };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

async function signUp(body: Body) {
  const answer = await http.request('POST', `${api}/accounts`, { body });
  if (answer.status !== 202) return { answer, body: undefined };
  return { answer, body: (await outcome((answer.body as Body).operationId as string)).body as Body | undefined };
}

const alice = { email: 'alice@example.com', password: 'correct horse', name: 'Alice' };

describe('signing up', () => {
  it('creates an account whose id is the operation result', async () => {
    const { answer, body } = await signUp(alice);
    expect(answer.status).toBe(202);
    expect(body).toMatchObject({ status: 'SUCCESS', result: expect.any(String) });
  });

  it.each([
    ['an email that does not look like one', { ...alice, email: 'alice@example' }, 'InvalidEmailFormat'],
    ['a password of 7 characters', { ...alice, email: 'p@example.com', password: '1234567' }, 'InvalidPassword'],
    ['an empty name', { ...alice, email: 'n@example.com', name: '' }, 'InvalidAccountName'],
    ['a name of spaces', { ...alice, email: 'n@example.com', name: '   ' }, 'InvalidAccountName'],
    ['a name of 61 characters', { ...alice, email: 'n@example.com', name: 'a'.repeat(61) }, 'InvalidAccountName'],
    ['an email already used, whatever its case', { ...alice, email: 'ALICE@Example.COM' }, 'EmailAlreadyUsed'],
  ])('refuses %s, behind the 202', async (_, body, type) => {
    const result = await signUp(body);
    expect(result.answer.status).toBe(202);
    expect(result.body).toMatchObject({ status: 'ERROR', error: { type, message: expect.any(String) } });
  });

  it('accepts a name of 60 characters and an email whose domain is one letter and a dot', async () => {
    const { body } = await signUp({ email: 'a@b.c', password: '12345678', name: 'a'.repeat(60) });
    expect(body).toMatchObject({ status: 'SUCCESS' });
  });

  it.each([
    ['a missing field', { email: 'x@example.com', password: '12345678' }],
    ['a field of the wrong type', { email: 'x@example.com', password: 12345678, name: 'X' }],
    ['a null field', { email: 'x@example.com', password: '12345678', name: null }],
  ])('refuses %s at once with 400', async (_, body) => {
    expect((await http.request('POST', `${api}/accounts`, { body })).status).toBe(400);
  });

  it('refuses no body at once with 400', async () => {
    expect((await http.request('POST', `${api}/accounts`)).status).toBe(400);
  });
});

describe('signing in', () => {
  it('answers a token for the right password, whatever the case of the email', async () => {
    const answer = await http.request('POST', `${api}/accounts/login`, {
      body: { email: 'Alice@example.com', password: alice.password },
    });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ token: expect.any(String) });
  });

  it('refuses a wrong password and an unknown email with the same answer', async () => {
    const wrong = await http.request('POST', `${api}/accounts/login`, {
      body: { email: alice.email, password: 'wrong password' },
    });
    const unknown = await http.request('POST', `${api}/accounts/login`, {
      body: { email: 'nobody@example.com', password: alice.password },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('refuses a body of the wrong shape with 400', async () => {
    expect((await http.request('POST', `${api}/accounts/login`, { body: { email: alice.email } })).status).toBe(400);
  });
});

describe('reading one’s own account', () => {
  const login = async (body: Body) =>
    ((await http.request('POST', `${api}/accounts/login`, { body })).body as { token: string }).token;

  it('answers the account of the token', async () => {
    const token = await login({ email: alice.email, password: alice.password });
    const answer = await http.get(`${api}/accounts/me`, { token });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ id: expect.any(String), email: alice.email, name: 'Alice' });
  });

  it('refuses no token, and a token that proves nothing, with 401', async () => {
    expect((await http.get(`${api}/accounts/me`)).status).toBe(401);
    expect((await http.get(`${api}/accounts/me`, { token: 'nonsense' })).status).toBe(401);
    expect((await http.get(`${api}/accounts/me`, { token: 'someone.AAAA' })).status).toBe(401);
  });

  it('keeps the operation of a signed-in caller to that caller', async () => {
    await signUp({ email: 'bob@example.com', password: '12345678', name: 'Bob' });
    const token = await login({ email: 'bob@example.com', password: '12345678' });
    // Signed up anonymously: anyone holding its id reads it, with a token or without.
    const { answer } = await signUp({ email: 'carol@example.com', password: '12345678', name: 'Carol' });
    const id = (answer.body as Body).operationId as string;
    expect((await http.get(`${api}/operations/${id}`, { token })).status).toBe(200);
    expect((await http.get(`${api}/operations/${id}`)).status).toBe(200);
  });
});
