import { AlreadyExistsException, Exception } from '@Architecture/Domain';

/** The name of a template is empty, only spaces, or longer than 60 characters (request 25). */
export class InvalidTemplateNameException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidTemplateName',
      message: 'A template has a name of 1 to 60 characters, that is not only spaces',
    });
  }
}

/** The split of a template is not split between one or more members of the group, each listed once, with at least 1 share (request 25). */
export class InvalidTemplateSplitException extends Exception {
  constructor() {
    super({
      service: 'Ledger',
      type: 'InvalidTemplateSplit',
      message:
        'A template is split between one or more members of the group, each listed once, each with at least 1 share',
    });
  }
}

/**
 * The group has a template of that name already, whatever its case (request 25): a thing that already exists, so the answer is `409`
 * (the transport's rule for `AlreadyExistsException`), named by this rule.
 */
export class TemplateNameTakenException extends AlreadyExistsException {
  constructor() {
    super('Ledger', 'The group has a template of that name already');
    this.type = 'TemplateNameTaken';
  }
}
