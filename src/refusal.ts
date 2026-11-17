/**
 * A request the application refuses at once: `statusCode` is the `4xx` answered. `type` names the
 * rule that refused it (PascalCase), as an operation's error does; `message` says it in a sentence.
 */
export class Refusal extends Error {
  constructor(
    readonly statusCode: 401 | 403 | 404 | 409 | 422 | 424,
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = 'Refusal';
  }
}
