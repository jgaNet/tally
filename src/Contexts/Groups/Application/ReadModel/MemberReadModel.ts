/** A member of a group as a member reads it: the account, its name, its role, and when it joined. */
export interface MemberReadModel {
  memberId: string;
  name: string;
  role: 'owner' | 'member';
  joinedAt: string;
}
