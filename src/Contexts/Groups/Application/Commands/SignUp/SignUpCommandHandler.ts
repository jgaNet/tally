import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';

import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { EmailAlreadyUsed } from '@Contexts/Groups/Domain/Account/AccountExceptions';
import { Name } from '@Contexts/Groups/Domain/Account/Name';
import { Password } from '@Contexts/Groups/Domain/Account/Password';
import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { IPasswordHasher } from '@Contexts/Groups/Domain/Account/Ports/IPasswordHasher';
import { SignUpCommandEvent } from '@Contexts/Groups/Application/Commands/SignUp/SignUpCommandEvent';

/** Anyone may sign up; the operation answers the id of the account, born with it. */
export class SignUpCommandHandler extends CommandHandler<SignUpCommandEvent> {
  constructor(
    private accounts: IAccountRepository,
    private passwordHasher: IPasswordHasher,
  ) {
    super();
  }

  anyoneMayAsk(): boolean {
    return true;
  }

  async execute({ payload }: SignUpCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const email = Email.create(payload.email);
    if (email.isFailure()) return email;
    const name = Name.create(payload.name);
    if (name.isFailure()) return name;
    const password = Password.create(payload.password);
    if (password.isFailure()) return password;

    if (await this.accounts.findByEmail(email.data)) return Result.fail(new EmailAlreadyUsed());

    const account = Account.register({
      email: email.data,
      name: name.data,
      passwordHash: this.passwordHasher.hash(password.data.value),
    });
    const saved = await this.accounts.save(account);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(account, context);
    return Result.ok(account._id.value);
  }
}
