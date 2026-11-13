/**
 * The few extension APIs the tests call inside the browser (in the service worker or the popup
 * page), typed here rather than pulling in all of `@types/chrome`.
 */
declare namespace chrome.action {
  function openPopup(): Promise<void>;
}

declare namespace chrome.tabs {
  interface Tab {
    id?: number;
    url?: string;
  }
  interface QueryInfo {
    active?: boolean;
    currentWindow?: boolean;
    url?: string | string[];
  }
  function query(info: QueryInfo): Promise<Tab[]>;
  function get(tabId: number): Promise<Tab>;
}
