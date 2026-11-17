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

type Operation = { status: string; result?: string; error?: { type: string; message: string } };

/** Follows an operation to its end, as a client answered 202 does. */
async function outcome(operationId: string, token?: string): Promise<Operation> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    expect(status).toBe(200);
    if ((body as Operation).status !== 'PENDING') return body as Operation;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

async function signUp(email: string, password = 'correct horse', name = 'Alice') {
  const answer = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  if (answer.status !== 202) return { answer };
  return { answer, operation: await outcome((answer.body as { operationId: string }).operationId) };
}

const login = (email: string, password = 'correct horse') =>
  http.request('POST', `${api}/accounts/login`, { body: { email, password } });

describe('accounts', () => {
  it('signs up, signs in and reads one’s own account', async () => {
    const { operation } = await signUp('alice@example.com');
    expect(operation).toMatchObject({ status: 'SUCCESS', result: expect.any(String) });

    const signedIn = await login('alice@example.com');
    expect(signedIn.status).toBe(200);
    const token = (signedIn.body as { token: string }).token;

    const me = await http.get(`${api}/accounts/me`, { token });
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ id: operation?.result, email: 'alice@example.com', name: 'Alice' });
  });

  it('refuses the values a sign-up may not have, on its operation', async () => {
    const refusals: [string, string, string, string][] = [
      ['no-at.example.com', 'correct horse', 'Bob', 'InvalidEmailFormat'],
      ['bob@example.com', '1234567', 'Bob', 'PasswordTooShort'],
      ['bob@example.com', 'correct horse', '   ', 'InvalidName'],
      ['bob@example.com', 'correct horse', 'x'.repeat(61), 'InvalidName'],
    ];
    for (const [email, password, name, type] of refusals) {
      const { operation } = await signUp(email, password, name);
      expect(operation).toMatchObject({ status: 'ERROR', error: { type, message: expect.any(String) } });
    }
  });

  it('refuses an email an account already uses, whatever its case', async () => {
    await signUp('carol@example.com');

    const { operation } = await signUp('CAROL@Example.com');

    expect(operation).toMatchObject({ status: 'ERROR', error: { type: 'EmailAlreadyUsed' } });
  });

  it('answers 400 to a body with a field missing or of the wrong type', async () => {
    for (const body of [
      {},
      { email: 'dan@example.com', password: 'correct horse' },
      { email: 1, password: 'x', name: 'D' },
    ]) {
      expect((await http.request('POST', `${api}/accounts`, { body })).status).toBe(400);
    }
    expect((await http.request('POST', `${api}/accounts/login`, { body: { email: 'a@b.c' } })).status).toBe(400);
  });

  it('refuses a wrong password and an unknown email with the same 401', async () => {
    await signUp('erin@example.com');

    const wrong = await login('erin@example.com', 'wrong password');
    const unknown = await login('nobody@example.com');

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('signs in whatever the case of the email', async () => {
    await signUp('Frank@Example.com');

    expect((await login('frank@EXAMPLE.com')).status).toBe(200);
  });

  it('answers 401 to who reads an account with no token, or one that proves nothing', async () => {
    expect((await http.get(`${api}/accounts/me`)).status).toBe(401);
    expect((await http.get(`${api}/accounts/me`, { token: 'not-a-token' })).status).toBe(401);
  });

  it('gives each person their own account, and an operation only to who asked', async () => {
    await signUp('gina@example.com', 'correct horse', 'Gina');
    await signUp('hugo@example.com', 'correct horse', 'Hugo');
    const gina = ((await login('gina@example.com')).body as { token: string }).token;
    const hugo = ((await login('hugo@example.com')).body as { token: string }).token;

    expect((await http.get(`${api}/accounts/me`, { token: gina })).body).toMatchObject({ name: 'Gina' });
    expect((await http.get(`${api}/accounts/me`, { token: hugo })).body).toMatchObject({ name: 'Hugo' });
  });

  it('answers 404 to an operation that does not exist', async () => {
    expect((await http.get(`${api}/operations/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await http.get(`${api}/operations/whatever`)).status).toBe(404);
  });
});
