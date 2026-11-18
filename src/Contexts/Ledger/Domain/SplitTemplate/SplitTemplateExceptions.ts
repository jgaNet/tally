import { ConflictException, Exception } from '@Architecture/Domain';

/** The name is not from 1 to 60 characters, or is only spaces. */
export class InvalidTemplateNameException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidTemplateName',
      message: 'A template’s name is from 1 to 60 characters, not only spaces',
    });
  }
}

/** The template splits between no member at all. */
export class InvalidTemplateSplitException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidTemplateSplit',
      message: 'A template splits between at least one member',
    });
  }
}

/** Another template of the group has the name, whatever its case (request 25). */
export class DuplicateTemplateNameException extends ConflictException {
  constructor() {
    super({
      service: 'Ledger',
      type: 'DuplicateTemplateName',
      message: 'The group already has a template of that name',
    });
  }
}
