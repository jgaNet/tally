import { IResult } from '@Architecture/Domain';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

export interface INoticeRepository {
  /** Stores a new notice, in the transaction it is made in. A notice is never changed once made. */
  save(notice: Notice): Promise<IResult>;
}
