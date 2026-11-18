import { LedgerException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

/** A template's name is 1 to 60 characters, not only spaces (request 25). */
export class InvalidTemplateName extends LedgerException {
  constructor() {
    super('InvalidTemplateName', 'A template name has 1 to 60 characters and is not only spaces');
  }
}

/** The group has a template of this name already, whatever its case: a name is free in its group. */
export class TemplateNameTaken extends LedgerException {
  constructor() {
    super('TemplateNameTaken', 'The group has a template with this name already');
  }
}

/** A template splits between at least one member. */
export class EmptyTemplateSplit extends LedgerException {
  constructor() {
    super('EmptyTemplateSplit', 'A template splits between at least one member');
  }
}

/** Only the member who saved a template, or the owner of its group, may replace or remove it (request 25). */
export class NotTheSaverOrTheOwner extends LedgerException {
  constructor() {
    super('NotTheSaverOrTheOwner', 'Only the member who saved the template or the owner of the group may change it');
  }
}
