import { useCallback, useEffect, useRef, useState } from "react";
import { browser } from "wxt/browser";

import { Button } from "../../components/ui/button";
import { naturalRect, type Rect, rectFromCorners, toNatural } from "../../lib/annotate";
import type {
  FeedbackPendingResponse,
  FeedbackResultMessage,
  FeedbackSession
} from "../../shared/messages";

/** Modes that annotate over the screenshot (vs. the button-only confirm/choose). */
const SPATIAL = new Set(["point", "element", "comment", "region"]);

export function App() {
  const session = usePendingSession();

  return (
    <div className="min-h-screen bg-base-100 p-4 text-base-content">
      <header className="mb-3 flex items-center gap-2">
        <span className="h-2 w-2 flex-none rounded-full bg-primary" />
        <span className="text-sm font-semibold">OpenCode Browser</span>
        <span className="ml-auto text-xs opacity-60">feedback</span>
      </header>
      {session ? (
        <Request key={session.id} session={session} />
      ) : (
        <p className="mt-8 text-center text-sm opacity-60">
          No feedback request right now. When an agent asks for input on a page it can't draw on, it
          appears here.
        </p>
      )}
    </div>
  );
}

/** Track the request the background says is pending, re-querying on change. */
function usePendingSession(): FeedbackSession | null {
  const [session, setSession] = useState<FeedbackSession | null>(null);
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void browser.runtime
        .sendMessage({ type: "feedback:get-pending" })
        .then((r: FeedbackPendingResponse | undefined) => {
          if (alive) {
            setSession(r?.session ?? null);
          }
        })
        .catch(() => {});
    };
    load();
    const onMsg = (m: unknown): void => {
      if ((m as { type?: string })?.type === "feedback:pending-changed") {
        load();
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => {
      alive = false;
      chrome.runtime.onMessage.removeListener(onMsg);
    };
  }, []);
  return session;
}

function respond(id: string, responded: boolean, annotations: unknown[]): void {
  void browser.runtime
    .sendMessage({
      type: "ocb-feedback-result",
      id,
      responded,
      annotations
    } satisfies FeedbackResultMessage)
    .catch(() => {});
}

function Request({ session }: { session: FeedbackSession }) {
  const [done, setDone] = useState(false);
  const finish = useCallback(
    (responded: boolean, annotations: unknown[]) => {
      respond(session.id, responded, annotations);
      setDone(true);
    },
    [session.id]
  );

  if (done) {
    return (
      <p className="mt-8 text-center text-sm opacity-60">Thanks — you can close this panel.</p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm">{session.prompt || defaultPrompt(session.mode)}</p>
      {session.mode === "confirm" ? (
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => finish(true, [{ kind: "confirm", value: false }])}
          >
            No
          </Button>
          <Button onClick={() => finish(true, [{ kind: "confirm", value: true }])}>Yes</Button>
        </div>
      ) : session.mode === "choose" ? (
        <div className="flex flex-wrap justify-end gap-2">
          {(session.options ?? []).map((opt) => (
            <Button
              key={opt}
              variant="outline"
              onClick={() => finish(true, [{ kind: "choice", value: opt }])}
            >
              {opt}
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={() => finish(false, [])}>
            Skip
          </Button>
        </div>
      ) : SPATIAL.has(session.mode) ? (
        <ScreenshotAnnotator session={session} onFinish={finish} />
      ) : (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => finish(false, [])}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

function defaultPrompt(mode: string): string {
  if (mode === "region") {
    return "Drag a box over the area you mean.";
  }
  if (mode === "comment") {
    return "Click a spot, then add a note.";
  }
  return "Click the element you mean.";
}

/** Click/drag over the captured screenshot; coordinates map to screenshot pixels. */
function ScreenshotAnnotator({
  session,
  onFinish
}: {
  session: FeedbackSession;
  onFinish: (responded: boolean, annotations: unknown[]) => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const isRegion = session.mode === "region";
  const [point, setPoint] = useState<{ dx: number; dy: number } | null>(null); // display px
  const [band, setBand] = useState<Rect | null>(null); // display px
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [note, setNote] = useState("");

  // Live image box + natural dimensions, fed to the pure mapping helpers.
  const metrics = (): {
    box: { width: number; height: number };
    natural: { width: number; height: number };
  } => {
    const img = imgRef.current;
    const r = img?.getBoundingClientRect();
    return {
      box: { width: r?.width ?? 0, height: r?.height ?? 0 },
      natural: { width: img?.naturalWidth ?? 0, height: img?.naturalHeight ?? 0 }
    };
  };
  const local = (e: { clientX: number; clientY: number }): { dx: number; dy: number } => {
    const r = imgRef.current?.getBoundingClientRect();
    return { dx: e.clientX - (r?.left ?? 0), dy: e.clientY - (r?.top ?? 0) };
  };

  const onDown = (e: React.MouseEvent): void => {
    const { dx, dy } = local(e);
    if (isRegion) {
      drag.current = { x: dx, y: dy };
      setBand({ x: dx, y: dy, width: 0, height: 0 });
    } else {
      setPoint({ dx, dy });
    }
  };
  const onMove = (e: React.MouseEvent): void => {
    if (!isRegion || !drag.current) {
      return;
    }
    const { dx, dy } = local(e);
    const s = drag.current;
    setBand(rectFromCorners(s.x, s.y, dx, dy));
  };
  const onUp = (): void => {
    drag.current = null;
  };

  const canSubmit = isRegion ? band !== null && band.width > 3 : point !== null;

  const submit = (): void => {
    const text = note.trim();
    const { box, natural } = metrics();
    if (isRegion && band) {
      const rect = naturalRect(band, box, natural);
      onFinish(true, [{ kind: "region", rect, refs: [], ...(text ? { text } : {}) }]);
    } else if (point) {
      const p = toNatural({ dx: point.dx, dy: point.dy }, box, natural);
      onFinish(true, [{ kind: "point", x: p.x, y: p.y, ...(text ? { text } : {}) }]);
    }
  };

  return (
    <div className="space-y-2">
      <div className="relative inline-block select-none overflow-hidden rounded-box border border-base-300">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: an annotation canvas over a screenshot */}
        <div
          className="cursor-crosshair"
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
        >
          <img
            ref={imgRef}
            src={session.screenshot}
            alt="Page screenshot — click or drag to mark what you mean"
            className="block max-h-[70vh] w-full object-contain"
          />
          {point && !isRegion ? (
            <span
              className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-primary/40"
              style={{ left: point.dx, top: point.dy }}
            />
          ) : null}
          {band && isRegion ? (
            <span
              className="pointer-events-none absolute border-2 border-dashed border-primary bg-primary/10"
              style={{ left: band.x, top: band.y, width: band.width, height: band.height }}
            />
          ) : null}
        </div>
      </div>

      {session.mode === "comment" ? (
        <textarea
          className="textarea textarea-bordered w-full text-sm"
          placeholder="Add a note (optional)…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => onFinish(false, [])}>
          Skip
        </Button>
        <Button size="sm" disabled={!canSubmit} onClick={submit}>
          Submit
        </Button>
      </div>
    </div>
  );
}
