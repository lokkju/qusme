/** The popup asks the background to insert the draft the user chose into a tab (spec 11.5). */
export const INSERT_MESSAGE = 'qusme.insert';
export interface InsertMessage {
  type: typeof INSERT_MESSAGE;
  tabId: number;
  /** The chosen draft's `d`. */
  d: string;
}

/** The popup asks the background to record insertions that could not be published yet. */
export const RETRY_RECORD_MESSAGE = 'qusme.insertion.retry';
