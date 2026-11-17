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
 * A rule refused because what it asks for already exists or clashes with what is kept (an email already
 * registered): a conflict the caller can act on, answered `409` at once by the Lite transport (ADR 4).
 */
export class ConflictException extends Exception {
  constructor(service: string, type: string, message: string, context?: unknown) {
    super({
      service: service || 'unknown',
      type,
      message,
      context,
    });
  }
}

/**
 * The caller's proof was refused: wrong credentials, whoever is asking. Answered `401` on every route, whether
 * or not the caller is signed in (ADR 4); a `NotAllowedException` is `403` to someone signed in.
 */
export class UnauthenticatedException extends Exception {
  constructor(service: string, type: string, message: string, context?: unknown) {
    super({
      service: service || 'unknown',
      type,
      message,
      context,
    });
  }
}
