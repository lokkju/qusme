/** The popup asks the background to insert the armed draft into a tab (spec 11.5 step 5). */
export const INSERT_MESSAGE = 'qusme.insert';
export interface InsertMessage {
  type: typeof INSERT_MESSAGE;
  tabId: number;
}

/** The popup asks the background to record insertions that could not be published yet. */
export const RETRY_RECORD_MESSAGE = 'qusme.insertion.retry';
