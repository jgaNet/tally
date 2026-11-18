import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidTemplateNameException } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateExceptions';

/**
 * The name of a split template: 1 to 60 characters once the surrounding spaces are taken away, and not only spaces. Stored trimmed.
 * Two templates of a group never have the same name, whatever its case (request 25): see `templateNameKey()`.
 */
export class SplitTemplateName extends ValueObject<string> {
  static readonly MAX_LENGTH = 60;

  private constructor(name: string) {
    super(name);
  }

  static create(raw: string): IResult<SplitTemplateName> {
    const name = raw.trim();
    if (name.length === 0 || name.length > SplitTemplateName.MAX_LENGTH) {
      return Result.fail(new InvalidTemplateNameException());
    }
    return Result.ok(new SplitTemplateName(name));
  }
}

/**
 * The key a template's name is unique by within its group: the name with its surrounding spaces taken away, in lower case. Two names
 * with the same key are the same name, so the store finds a template by it (`ISplitTemplates.findByName`).
 */
export const templateNameKey = (raw: string): string => raw.trim().toLowerCase();
