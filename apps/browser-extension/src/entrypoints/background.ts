import { defineBackground } from "#imports";

import { BridgeClient } from "../background/bridge-client";
import { CdpExecutor } from "../background/cdp-executor";
import { CommandRouter } from "../background/command-router";
import { ContentExecutor } from "../background/content-executor";
import { detectCapabilities, type Executor, resolveExecutorKind } from "../background/executor";
import { getActiveFeedbackSession } from "../background/feedback-side-panel";
import { GroupRegistry } from "../background/group-registry";
import { startNetworkRecorder } from "../background/network-recorder";
import { getSettings, getStatus, saveSettings, setStatus } from "../shared/db";
import type { FeedbackPendingResponse, UiMessage, UiMessageResponse } from "../shared/messages";
import type { ExecutorKind, ExecutorMode } from "../shared/types";

export default defineBackground(() => {
  // Firefox has no CDP, so network comes from webRequest and console/dialogs
  // from the `hooks.content` entrypoint (installed at document_start). All of it
  // is passive: no debugger banner.
  startNetworkRecorder();

  let executor: Executor = new ContentExecutor();
  let registry = new GroupRegistry(executor);
  let router = new CommandRouter(registry, executor);
  let executorKind: ExecutorKind = "content";

  // Rebuild the executor stack from current settings. Called at boot and after
  // the user changes settings (executor mode may have flipped).
  async function rebuild(): Promise<void> {
    const settings = await getSettings();
    // Detach the outgoing executor's debugger sessions before replacing it,
    // otherwise the "being debugged" banner sticks and a later switch back to
    // CDP starts with an empty (stale) attachment set.
    await executor.releaseAll().catch(() => {});
    executorKind = resolveExecutorKind(settings.executorMode, detectCapabilities());
    executor = executorKind === "cdp" ? new CdpExecutor() : new ContentExecutor();
    registry = new GroupRegistry(executor);
    router = new CommandRouter(registry, executor);
    // Recover groups tracked before an MV3 worker suspend / rebuild.
    await registry.hydrate();
  }

  const client = new BridgeClient({
    getConfig: async () => {
      const s = await getSettings();
      return {
        url: s.bridgeUrl,
        token: s.token,
        id: s.browserId,
        label: s.label || s.browserId,
        browser: import.meta.env.BROWSER
      };
    },
    onCommand: (frame) => router.handle(frame),
    onCancel: (id) => router.cancel(id),
    executorKind: () => executorKind,
    // The plugin-side `executor` option (when set) wins over the dashboard
    // choice on each connect — rebuild the stack if it differs.
    onServerPreference: async (mode: ExecutorMode) => {
      const settings = await getSettings();
      if (settings.executorMode === mode) {
        return;
      }
      await saveSettings({ executorMode: mode });
      await rebuild();
      await setStatus({ executor: executorKind });
    },
    // Release control (detach the CDP debugger) when the link drops, so the
    // browser isn't left with the "being debugged" banner after the agent stops.
    onDisconnected: () => executor.releaseAll(),
    // Plugin asked us to hand control back (browser_release / shutdown).
    onRelease: () => executor.releaseAll(),
    clientName: `opencode-browser-ext/${import.meta.env.BROWSER}`
  });

  // Boot: build the stack, then dial the bridge.
  void (async () => {
    await rebuild();
    await client.connect();
  })();

  // Control channel from the popup / dashboard / side panel.
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const type = (message as { type?: string })?.type;
    // Side panel asks what request (if any) it should render.
    if (type === "feedback:get-pending") {
      sendResponse({ session: getActiveFeedbackSession() } satisfies FeedbackPendingResponse);
      return true;
    }
    if (type === "reconnect" || type === "disconnect" || type === "get_status") {
      void (async () => {
        const m = message as UiMessage;
        if (m.type === "reconnect") {
          await rebuild();
          await client.reconnect();
        } else if (m.type === "disconnect") {
          client.disconnect();
        }
        const status = await getStatus();
        sendResponse({ status } satisfies UiMessageResponse);
      })();
      return true; // keep the message channel open for the async response
    }
    // Not ours (e.g. ocb-feedback-result) — handled by the per-request listener.
    return false;
  });

  // Keep the registry honest when the user closes a driven tab by hand.
  chrome.tabs.onRemoved.addListener((tabId) => {
    void registry.forget(tabId);
  });
});
