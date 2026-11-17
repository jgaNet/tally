import { CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';
import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';
import { EmailAlreadyUsed } from '@Contexts/Groups/Domain/Account/AccountExceptions';
import { Password } from '@Contexts/Groups/Domain/Account/Password';
import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { IPasswordHasher } from '@Contexts/Groups/Application/Ports/IPasswordHasher';
import { SignUpCommandEvent } from '@Contexts/Groups/Application/Commands/SignUp/SignUpCommandEvent';

/** Anyone may sign up. The result is the new account's id. */
export class SignUpCommandHandler extends CommandHandler<SignUpCommandEvent> {
  constructor(
    private readonly accounts: IAccountRepository,
    private readonly hasher: IPasswordHasher,
  ) {
    super();
  }

  override anyoneMayAsk(): boolean {
    return true;
  }

  async execute({ payload }: SignUpCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const email = Email.create(payload.email);
    if (email.isFailure()) return email;
    const password = Password.create(payload.password);
    if (password.isFailure()) return password;
    const name = AccountName.create(payload.name);
    if (name.isFailure()) return name;

    if (await this.accounts.findByEmail(email.data)) return Result.fail(new EmailAlreadyUsed());

    const account = Account.register({
      email: email.data,
      name: name.data,
      passwordHash: await this.hasher.hash(password.data.value),
    });
    const saved = await this.accounts.save(account);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(account, context);
    return Result.ok(account._id.value);
  }
}
