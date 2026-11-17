import { Logger } from '@Architecture/Application';

import { debtSweep } from '@Contexts/Notifications/module.local';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';

/** One run of the debt sweep, in a context of its own, as the process runs it every interval. */
export function sweepDebts(app: FastifyApplication): Promise<void> {
  return debtSweep.run(app.executionContext('job'));
}

/**
 * Starts the application's background jobs (ADR 10): the debt sweep runs every JOBS_INTERVAL_SECONDS (60 when that is not set), in a
 * context of its own, so that what it saves and publishes goes through the outbox as a request's does. A run that is still going when
 * the next is due is not started again. The process starts them, not `createApplication`, so a test builds the application without a
 * timer. Returns the function that stops them.
 */
export function startJobs(app: FastifyApplication, logger: Logger): () => void {
  const seconds = Number(process.env.JOBS_INTERVAL_SECONDS) || 60;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sweepDebts(app)
      .catch(error => logger.error('The debt sweep failed', error))
      .finally(() => {
        running = false;
      });
  }, seconds * 1000);
  return () => clearInterval(timer);
}
