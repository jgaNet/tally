import { v4 as uuidv4 } from 'uuid';
import { AddressInfo } from 'net';

import Fastify, {
  FastifyError,
  FastifyInstance,
  FastifyPluginCallback,
  FastifyPluginOptions,
  FastifyRequest,
} from 'fastify';
import fastifyCors from '@fastify/cors';

import { Role } from '@SharedKernel/Domain';
import { Application, ExecutionContext, Logger, UnitOfWork } from '@Architecture/Application';
import { formatOf } from '@Architecture/Presentation/Format';
import { InMemoryUnitOfWork } from '@Architecture/Infrastructure/UnitOfWork/InMemoryUnitOfWork';

const ANONYMOUS = { subjectId: '', role: Role.GUEST };

export interface FastifyApplicationOptions {
  logger: Logger;
  /** Every route is served under it: `v1` serves `/notes` at `/v1/notes`. */
  apiPrefix: string;
  /** The port `start()` listens on when it is given none; 0 asks the OS for a free one. */
  port?: number;
  /** The origins a front end may call the API from (CORS); none: same-origin clients only. */
  webOrigins?: string[];
  /**
   * Says who is calling, by setting `request.auth`; the context that owns accounts provides it.
   * Without one, every caller is anonymous.
   */
  authenticate?(request: FastifyRequest): Promise<void>;
  /**
   * The unit of work each request (and each job) gets: the application's own store, in its file. Without one,
   * the in-memory unit of work, which persists nothing.
   */
  unitOfWork?: () => UnitOfWork;
}

/**
 * The transport, and nothing of the business: a Fastify server that gives each request its
 * identity and its ExecutionContext, serves the routes it is given under one prefix, and
 * listens. It names no context; a composition root (createApplication.ts) builds one, sets the
 * bus, registers the modules and the routes, and starts it.
 */
export class FastifyApplication extends Application {
  readonly fastify: FastifyInstance;
  readonly logger: Logger;
  readonly apiPrefix: string;
  readonly port: number;
  readonly #createUnitOfWork: () => UnitOfWork;
  readonly #jobs: NodeJS.Timeout[] = [];

  constructor({
    logger,
    apiPrefix,
    port = 0,
    webOrigins = [],
    authenticate,
    unitOfWork = () => new InMemoryUnitOfWork(),
  }: FastifyApplicationOptions) {
    super();
    this.logger = logger;
    this.apiPrefix = apiPrefix;
    this.port = port;
    this.#createUnitOfWork = unitOfWork;
    // A field of the wrong type is refused as it is (400, API-BODY-SHAPE), never coerced into the type asked for.
    this.fastify = Fastify({ logger: false, ajv: { customOptions: { coerceTypes: false } } });

    // Anonymous until the authentication says otherwise; without one, anonymous throughout.
    this.fastify.addHook('onRequest', async request => {
      request.auth = ANONYMOUS;
      await authenticate?.(request);
    });

    // One execution context per request: its trace, its caller, and its own unit of work.
    // A unit of work is a request-scoped thing; sharing one instance across requests would
    // make concurrent commands join each other's transaction.
    this.fastify.addHook('preHandler', (request, reply, done) => {
      const traceId = (request.headers['x-trace-id'] as string) || uuidv4();

      request.executionContext = this.executionContext(traceId, {
        subjectId: request.auth.subjectId,
        role: request.auth.role,
      });

      reply.header('x-trace-id', traceId);
      done();
    });

    // An HTMX answer is an HTML fragment; Fastify would label a string text/plain.
    this.fastify.addHook('onSend', async (request, reply, payload) => {
      const contentType = String(reply.getHeader('content-type') ?? '');
      if (formatOf(request) === 'htmx' && typeof payload === 'string' && contentType.startsWith('text/plain')) {
        reply.type('text/html; charset=utf-8');
      }
      return payload;
    });
    // The front end is a client like any other, served from wherever: a page on another origin
    // calls the API with a bearer token, never a cookie, and CORS lets it, for the origins given.
    if (webOrigins.length > 0) {
      this.fastify.register(fastifyCors, {
        origin: webOrigins,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
          'authorization',
          'content-type',
          'hx-request',
          'hx-target',
          'hx-trigger',
          'hx-current-url',
          'hx-boosted',
          'hx-push-url',
        ],
        exposedHeaders: ['x-trace-id'],
      });
    }
    // Only programming errors and schema violations get here: expected failures are Results.
    this.fastify.setErrorHandler((error: FastifyError, req, reply) => {
      const format = req.headers['hx-request'] ? 'htmx' : 'json';
      if (format === 'htmx') {
        return reply.code(error.statusCode || 500).send(`<div>${error.message}</div>`);
      }
      return reply.code(error.statusCode || 500).send(error);
    });
  }

  /** A context's routes, under `/<apiPrefix><prefix>`; `/` serves them at the prefix itself. */
  registerRoutes<Options extends FastifyPluginOptions>(
    prefix: string,
    routes: FastifyPluginCallback<Options>,
    options: Options,
  ): this {
    this.fastify.register(routes, {
      prefix: prefix === '/' ? `/${this.apiPrefix}` : `/${this.apiPrefix}${prefix}`,
      ...options,
    });
    return this;
  }

  /** Listens. Port 0 asks the OS for a free one (tests); `address` then says which. */

  /**
   * A context of its own, as each request gets one: its trace, its caller, the bus, the logger,
   * and a unit of work of its own. Whatever runs work outside a request runs it in one too, the
   * composition root's relay at start first (ADR 24): a reaction it delivers then runs in a
   * transaction of its own, and what it tells goes through the outbox under the entry's id, as
   * after a request (ADR 30). With no unit of work, the reaction would run with no transaction
   * and publish straight to the bus under a fresh id, which no subscriber can recognise again.
   */
  executionContext(traceId: string, auth: { subjectId?: string; role?: string } = {}): ExecutionContext {
    return new ExecutionContext({
      traceId,
      auth,
      eventBus: this.getEventBus(),
      unitOfWork: this.#createUnitOfWork(),
      logger: this.logger,
    });
  }
  async start(port: number = this.port): Promise<void> {
    await this.fastify.listen({ port, host: '127.0.0.1' });
    await this.fastify.ready();
    this.logger.info(`Listening on ${this.address}`);
  }

  /**
   * A background job: `job` runs every `intervalMs` for as long as the application runs, and a failure of one
   * run is logged, not fatal; the next run tries again. The timer does not keep the process alive.
   */
  schedule(intervalMs: number, job: () => Promise<unknown>): void {
    const timer = setInterval(() => {
      job().catch(error => this.logger.error('A background job failed', error));
    }, intervalMs);
    timer.unref();
    this.#jobs.push(timer);
  }

  async stop(): Promise<void> {
    this.#jobs.forEach(clearInterval);
    this.#jobs.length = 0;
    await this.fastify.close();
  }

  get address(): string {
    const { address, port } = this.fastify.server.address() as AddressInfo;
    return `http://${address}:${port}`;
  }
}
