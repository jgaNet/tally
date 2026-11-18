import { Exception } from '@Architecture/Domain';

/** The name is 1 to 60 characters, and not only spaces (after trimming) (request 25). */
export class InvalidTemplateNameException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidTemplateName',
      message: 'The name must have 1 to 60 characters, and not only spaces',
    });
  }
}

/** Two templates of a group never have the same name, whatever its case (request 25). */
export class TemplateNameTakenException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'TemplateNameTaken',
      message: 'The group already has a template with that name',
    });
  }
}

/** A template splits between at least one member (request 25: a template is a split, not an empty list). */
export class TemplateWithoutMembersException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'TemplateWithoutMembers',
      message: 'A template must split between at least one member',
    });
  }
}
