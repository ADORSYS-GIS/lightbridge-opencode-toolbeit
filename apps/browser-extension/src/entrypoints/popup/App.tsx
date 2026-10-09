import { useMutation } from "@tanstack/react-query";
import { browser } from "wxt/browser";

import { StatusBadge } from "../../components/status-badge";
import { Button } from "../../components/ui/button";
import { useActions, useGroups, useStatus } from "../../lib/hooks";
import { sendToBackground } from "../../lib/messaging";
import { timeAgo } from "../../lib/utils";

export function App() {
  const status = useStatus();
  const groups = useGroups();
  const actions = useActions();
  const lastAction = actions[0];
  const online = status.state === "connected" || status.state === "connecting";

  const toggle = useMutation({
    mutationFn: () => sendToBackground({ type: online ? "disconnect" : "reconnect" })
  });

  return (
    <div className="w-[360px] bg-base-100 p-4 text-base-content">
      <header className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Logo />
          <span className="text-sm font-semibold">OpenCode Browser</span>
        </div>
        <StatusBadge state={status.state} />
      </header>
      <p className="mb-3 text-xs opacity-60">
        An OpenCode agent drives this browser through a localhost bridge.
      </p>

      <div className="rounded-box border border-base-300 bg-base-200 px-3 py-2 text-xs opacity-80">
        <div className="flex items-center justify-between">
          <span>Bridge</span>
          <code>{status.executor ? `${status.executor} executor` : "—"}</code>
        </div>
        {status.lastError ? <p className="mt-1 text-error">{status.lastError}</p> : null}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Stat label="Groups" value={String(groups.length)} />
        <Stat label="Actions" value={String(actions.length)} />
      </div>

      {lastAction ? (
        <p className="mt-2 truncate text-xs opacity-60">
          <span className={lastAction.ok ? "text-success" : "text-error"}>{lastAction.action}</span>{" "}
          · {lastAction.summary} · {timeAgo(lastAction.ts)}
        </p>
      ) : (
        <p className="mt-2 text-xs opacity-60">No actions yet.</p>
      )}

      {!online ? (
        <p className="mt-2 text-xs opacity-60">
          First time? Open the Dashboard for the bridge URL, token and setup steps.
        </p>
      ) : null}

      <div className="mt-4 flex gap-2">
        <Button
          variant={online ? "outline" : "default"}
          className="flex-1"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate()}
        >
          {online ? "Disconnect" : "Connect"}
        </Button>
        <Button variant="ghost" onClick={() => browser.runtime.openOptionsPage()}>
          Dashboard
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-box border border-base-300 bg-base-200 px-3 py-2">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] uppercase tracking-wide opacity-60">{label}</div>
    </div>
  );
}

function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="2.5"
        y="4.5"
        width="19"
        height="15"
        rx="2.5"
        className="stroke-primary"
        strokeWidth="1.6"
      />
      <path d="M2.5 8.5h19" className="stroke-primary" strokeWidth="1.6" />
      <circle cx="5.5" cy="6.5" r="0.8" className="fill-primary" />
    </svg>
  );
}
