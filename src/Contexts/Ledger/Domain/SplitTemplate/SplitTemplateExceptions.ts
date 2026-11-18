import { Exception } from '@Architecture/Domain';

/** The base of every refusal the SplitTemplate aggregate makes (request 25). */
export abstract class SplitTemplateException extends Exception {
  constructor(type: string, message: string, context?: unknown) {
    super({ service: 'Ledger', type, message, context });
  }
}

export class InvalidTemplateName extends SplitTemplateException {
  constructor() {
    super('InvalidTemplateName', 'A template name is 1 to 60 characters, not only spaces');
  }
}

export class TemplateNameTaken extends SplitTemplateException {
  constructor() {
    super('TemplateNameTaken', 'The group has a template of that name already, whatever its case');
  }
}

/** A template is split between members, or by shares: exactly one of the two, and at least one member. */
export class TemplateSplitShape extends SplitTemplateException {
  constructor() {
    super(
      'TemplateSplitShape',
      'A template is split either between members or by shares, and lists at least one member',
    );
  }
}

export class NotAllowedToChangeTemplate extends SplitTemplateException {
  constructor() {
    super(
      'NotAllowedToChangeTemplate',
      'Only the member who saved a template, or the owner of its group, may change or remove it',
    );
  }
}
