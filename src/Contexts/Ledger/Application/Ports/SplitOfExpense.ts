import { IResult, NotFoundException, Result } from '@Architecture/Domain';

import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * The split an expense is decided with (request 25): the split the body gave, or, when it names a template, the split the template
 * was saved with, as if it had been given. The template must be one of the expense's group, else it is not found. Whether its members
 * are the group's members, and the payer among them, is decided by the expense, as for any split (ADR 16).
 */
export async function splitOfExpense(
  templates: ISplitTemplateRepository,
  groupId: string,
  given: { split?: SplitRequest; template?: string },
): Promise<IResult<SplitRequest>> {
  if (given.template === undefined) return Result.ok(given.split ?? { kind: 'equal', memberIds: [] });

  const template = await templates.findById(given.template);
  if (!template || template.groupId !== groupId) {
    return Result.fail(new NotFoundException('Ledger', 'Template not found'));
  }
  return Result.ok(template.split);
}
