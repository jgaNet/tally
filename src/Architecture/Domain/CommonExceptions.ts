import { Exception } from './Exception';

export class UnknownException extends Exception {
  constructor(message: string, context?: unknown) {
    super({
      service: 'unknown',
      type: 'Unknown',
      message,
      context,
    });
  }
}

export class NotFoundException extends Exception {
  constructor(service: string, message: string, context?: unknown) {
    super({
      service: service || 'unknown',
      type: 'NotFound',
      message,
      context,
    });
  }
}

export class NotAllowedException extends Exception {
  constructor(service: string, message: string, context?: unknown) {
    super({
      service: service || 'unknown',
      type: 'NotAllowed',
      message,
      context,
    });
  }
}

/** The aggregate changed since it was read: the caller re-reads and decides again (ADR 8). */
export class ConcurrencyConflictException extends Exception {
  constructor(service: string, message: string, context?: unknown) {
    super({
      service: service || 'unknown',
      type: 'ConcurrencyConflict',
      message,
      context,
    });
  }
}

/**
 * A rule refused because what it needs to be free is already taken: a second account on the same email. The
 * kind a transport answers `409` to, as it answers a concurrency conflict; the rule's own `type` names it.
 */
export class ConflictException extends Exception {}
