import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidTemplateName } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateExceptions';

/** What a split is saved under: 1 to 60 characters, not only spaces (request 25). */
export class TemplateName extends ValueObject<string> {
  static readonly MAX_LENGTH = 60;

  private constructor(text: string) {
    super(text);
  }

  static create(raw: string): IResult<TemplateName> {
    const length = Array.from(raw).length;
    if (raw.trim().length === 0 || length > TemplateName.MAX_LENGTH) return Result.fail(new InvalidTemplateName());
    return Result.ok(new TemplateName(raw));
  }

  /** The key two names of one group are the same by: a name whatever its case, so `Rent` and `rent` are one name. */
  static keyOf(raw: string): string {
    return raw.toLowerCase();
  }
}
