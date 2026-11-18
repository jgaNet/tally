import { ConflictException, Exception, NotAllowedException, NotFoundException } from '@Architecture/Domain';

const SERVICE = 'Ledger';

/** A template's name that is empty, only spaces, or longer than 60 characters: `422` (request 25). */
export class InvalidTemplateNameException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'InvalidTemplateName',
      message: 'A template name has 1 to 60 characters, and is not only spaces',
    });
  }
}

/** Another template of the group has the same name, whatever its case: `409` (request 25). */
export class TemplateNameTakenException extends ConflictException {
  constructor() {
    super(SERVICE, 'TemplateNameTaken', 'Another template of this group has this name');
  }
}

/** A template split between no member: `422` (request 25). */
export class NoTemplateMemberException extends Exception {
  constructor() {
    super({ service: SERVICE, type: 'NoTemplateMember', message: 'A template is split between at least one member' });
  }
}

/** A member is listed twice in a template's split: `422` (request 25). */
export class DuplicateTemplateMemberException extends Exception {
  constructor() {
    super({ service: SERVICE, type: 'DuplicateTemplateMember', message: 'A member is listed once in a template' });
  }
}

/** A member of a template is not a member of the group: `422` (request 25). */
export class TemplateMemberNotInGroupException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'TemplateMemberNotInGroup',
      message: 'Only members of the group can be in a template',
    });
  }
}

/** A member of a template's split with shares that are not a whole number of 1 or more: `422` (request 25). */
export class InvalidTemplateSharesException extends Exception {
  constructor() {
    super({
      service: SERVICE,
      type: 'InvalidTemplateShares',
      message: 'Each member of a template has a whole number of shares, at least 1',
    });
  }
}

/** The template is not there for the caller: the same `404` for one that does not exist and one of a group they are not in (request 25). */
export class TemplateNotFoundException extends NotFoundException {
  constructor() {
    super(SERVICE, 'No template is there for you with this id');
  }
}

/** The caller saved neither the template nor is the group's owner: `403` to a signed-in member (request 25). */
export class NotTheSaverOrOwnerException extends NotAllowedException {
  constructor() {
    super(SERVICE, 'Only the member who saved a template or the owner of its group may change or remove it');
  }
}
