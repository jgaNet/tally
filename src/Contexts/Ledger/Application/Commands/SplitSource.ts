import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';

import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';

/**
 * How an expense is split as a command gives it (request 25): by the split it gives, or by the template of its group named in place
 * of one. The transport gives exactly one of the two.
 */
export type SplitSource = SplitInput | { template: string };

/**
 * The split an expense is decided by. A split given is that split; a template named is the split it keeps, as if the command had given
 * it, and the template must be one of the expense's group (else it is not found). The members of the split are checked by the expense,
 * under the rules of its split, when it decides: a member who has left, or a payer not in it, is refused there.
 */
export async function resolveSplit(
  templates: ISplitTemplateRepository,
  groupId: string,
  source: SplitSource,
): Promise<IResult<SplitInput>> {
  if (!('template' in source)) return Result.ok(source);

  const template = await templates.findById(new Id(source.template));
  if (!template || template.groupId.value !== groupId) {
    return Result.fail(new NotFoundException('Ledger', 'Template not found', { id: source.template }));
  }
  const split: SplitInput = template.split;
  return Result.ok(split);
}
