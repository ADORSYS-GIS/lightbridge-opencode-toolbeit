import { browser } from "wxt/browser";

import type { UiMessage, UiMessageResponse } from "../shared/messages";

/** Send a control message to the background worker and await its status reply. */
export async function sendToBackground(message: UiMessage): Promise<UiMessageResponse> {
  return (await browser.runtime.sendMessage(message)) as UiMessageResponse;
}
