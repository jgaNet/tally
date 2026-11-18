import { IResult, Result, ValueObject } from '@Architecture/Domain';
import { InvalidTemplateName } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateExceptions';

/** The key two names of a group are compared by: the name in lower case. */
export function nameKeyOf(name: string): string {
  return name.toLowerCase();
}

/** The name a split is saved under: 1 to 60 characters, not only spaces (request 25). */
export class TemplateName extends ValueObject<string> {
  static readonly MAX_LENGTH = 60;

  private constructor(value: string) {
    super(value);
  }

  static of(raw: string): IResult<TemplateName> {
    const length = Array.from(raw).length;
    if (length < 1 || length > TemplateName.MAX_LENGTH || raw.trim() === '') {
      return Result.fail(new InvalidTemplateName());
    }
    return Result.ok(new TemplateName(raw));
  }

  /** The name as two templates of a group are compared: whatever its case, two names with the same key are the same name. */
  get key(): string {
    return nameKeyOf(this.value);
  }
}
