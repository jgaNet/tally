import { IResult, Result } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';

import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';
import { EmailAlreadyRegisteredException } from '@Contexts/Groups/Domain/Account/AccountExceptions';
import { Password } from '@Contexts/Groups/Domain/Account/Password';
import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { IPasswordHasher } from '@Contexts/Groups/Domain/Account/Ports/IPasswordHasher';

/**
 * Signing up, as a rule about the whole collection: the values are valid (an email, a name, a password of
 * at least 8 characters), and no other account uses the email. Its answer is a new account, not yet saved:
 * the handler saves it and publishes what it recorded.
 */
export class AccountRegistration {
  constructor(
    private accounts: IAccountRepository,
    private hasher: IPasswordHasher,
  ) {}

  async register({
    email,
    name,
    password,
  }: {
    email: string;
    name: string;
    password: string;
  }): Promise<IResult<Account>> {
    const address = Email.create(email);
    if (address.isFailure()) return Result.fail(address.error);

    const displayName = AccountName.create(name);
    if (displayName.isFailure()) return Result.fail(displayName.error);

    const secret = Password.create(password);
    if (secret.isFailure()) return Result.fail(secret.error);

    if (await this.accounts.findByEmail(address.data)) {
      return Result.fail(new EmailAlreadyRegisteredException());
    }

    const passwordHash = await this.hasher.hash(secret.data.value);
    return Result.ok(Account.create({ email: address.data, name: displayName.data, passwordHash }));
  }
}
