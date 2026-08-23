import type { Logger } from "@vymalo/opencode-core-otel";

export function silentLogger(): Logger & { events: Array<[string, unknown]> } {
  const events: Array<[string, unknown]> = [];
  const push =
    (level: string) =>
    (event: string, fields?: unknown): void => {
      events.push([`${level}:${event}`, fields]);
    };
  return {
    events,
    trace: push("trace"),
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error")
  };
}

export function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    sessionID: "ses_1",
    role: "assistant",
    modelID: "kimi-k2.6",
    providerID: "camer-digital",
    mode: "build",
    parentID: "msg_0",
    path: { cwd: "/repo", root: "/repo" },
    cost: 0.0125,
    tokens: { input: 1200, output: 340, reasoning: 88, cache: { read: 9600, write: 400 } },
    time: { created: 1_000, completed: 3_500 },
    finish: "stop",
    ...overrides
  };
}
