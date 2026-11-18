import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { OneSplitOnly } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { Split } from '@Contexts/Ledger/Domain/Expense/Split';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';

/**
 * The split an expense is given (request 25): exactly one of the three split fields, or `template` in their place. A template
 * gives the split it was saved with, as if that had been given, under the same rules; it must be a template of the expense's
 * group, else it is not found. Its members are checked when the expense is decided, as for any split (GroupMembers).
 */
export async function splitOfExpense({
  amount,
  payer,
  groupId,
  request,
  templates,
}: {
  amount: Amount;
  payer: Id;
  groupId: Id;
  request: SplitRequest & { template?: string };
  templates: ISplitTemplateRepository;
}): Promise<IResult<Split>> {
  if (request.template === undefined) return Split.fromRequest({ amount, payer, request });

  const givenFields = [request.splitBetween, request.splitExactly, request.splitByShares].filter(
    field => field !== undefined,
  );
  if (givenFields.length !== 0) return Result.fail(new OneSplitOnly());

  const template = await templates.findById(new Id(request.template));
  if (template === null || !template.groupId.equals(groupId)) {
    return Result.fail(new NotFoundException('Ledger', 'Template not found'));
  }
  return Split.fromRequest({ amount, payer, request: template.asSplitRequest() });
}
