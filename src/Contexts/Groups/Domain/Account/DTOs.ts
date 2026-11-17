/** The plain shape of an account that crosses to the infrastructure: its snapshot, the version it was read at included. */
export interface IAccountSnapshot {
  _id: string;
  email: string;
  name: string;
  passwordHash: string;
  version: number;
}
