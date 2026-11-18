import { IResult, Result, ValueObject } from '@Architecture/Domain';

import { InvalidTemplateNameException } from './SplitTemplateExceptions';

/**
 * The key a template's name is unique by in its group (request 25): the name trimmed and in lower case, so that two names that differ
 * in case alone are one name. The store keeps it beside the name, and the domain asks the store whether it is taken.
 */
export const templateNameKeyOf = (raw: string): string => raw.trim().toLowerCase();

/** The name of a split template: 1 to 60 characters once trimmed, never only spaces (request 25). */
export class TemplateName extends ValueObject<string> {
  static readonly MAX_LENGTH = 60;

  private constructor(name: string) {
    super(name);
  }

  static create(raw: string): IResult<TemplateName> {
    const name = raw.trim();
    const length = Array.from(name).length;
    if (length < 1 || length > TemplateName.MAX_LENGTH) {
      return Result.fail(new InvalidTemplateNameException());
    }
    return Result.ok(new TemplateName(name));
  }
}
