import { IResult } from '@Architecture/Domain';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

export interface INoticeRepository {
  /** Stores a notice made in this transaction. A notice is never changed after it is made, so it is only ever inserted. */
  save(notice: Notice): Promise<IResult>;
}
