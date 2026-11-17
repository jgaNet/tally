/**
 * A request refused by a rule. `type` is the name of the rule, in PascalCase; `message` says the
 * same in a sentence. The error handler turns it into the answer `{ type, message }` at `statusCode`.
 */
export class Refusal extends Error {
  constructor(
    readonly statusCode: number,
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = 'Refusal';
  }
}
