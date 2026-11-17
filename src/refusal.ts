/**
 * A request the application refuses at once. `type` is the name of the rule that refused it, in
 * PascalCase, and `message` says the same in a sentence. Answered as `{ type, message }`.
 */
export class Refusal extends Error {
  constructor(
    readonly statusCode: 401 | 403 | 404 | 409 | 422,
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = 'Refusal';
  }
}
