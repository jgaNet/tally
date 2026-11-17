import { IResult, Result } from '@Architecture/Domain';
import { CommandHandler, ExecutionContext } from '@Architecture/Application';

import { AccountRegistration } from '@Contexts/Groups/Domain/Account/AccountRegistration';
import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { IPasswordHasher } from '@Contexts/Groups/Domain/Account/Ports/IPasswordHasher';
import { SignUpCommandEvent } from '@Contexts/Groups/Application/Commands/SignUp/SignUpCommandEvent';

/**
 * Signing up: anyone may ask for it, so no caller is required. The registration decides whether the values
 * are valid and the email is free; the account is saved and what it recorded is published with the save, in
 * one transaction. Its answer is the new account's id.
 */
export class SignUpCommandHandler extends CommandHandler<SignUpCommandEvent> {
  private registration: AccountRegistration;

  constructor(
    private accounts: IAccountRepository,
    hasher: IPasswordHasher,
  ) {
    super();
    this.registration = new AccountRegistration(accounts, hasher);
  }

  anyoneMayAsk(): boolean {
    return true;
  }

  async execute(event: SignUpCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const decided = await this.registration.register(event.payload);
    if (decided.isFailure()) return Result.fail(decided.error);

    const saved = await this.accounts.save(decided.data);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(decided.data, context);
    return Result.ok(decided.data._id.value);
  }
}
