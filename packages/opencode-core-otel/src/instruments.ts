import type { Counter, Histogram, Meter } from "@opentelemetry/api";

/**
 * Every metric this plugin emits, created once per plugin instance.
 *
 * Naming follows the GenAI semantic conventions where one exists
 * (`gen_ai.client.*`) and `opencode.*` otherwise — deliberately matching the
 * vocabulary `opencode-otel-plugin` already established, so both plugins' data
 * lands on the same dashboards. See `plans/otel.md`.
 */
export interface Instruments {
  /** Real USD, straight from `AssistantMessage.cost` — no price table involved. */
  cost: Counter;
  /** All five token types, discriminated by `gen_ai.token.type`. */
  tokens: Histogram;
  /** Assistant-message wall time, seconds. */
  duration: Histogram;
  sessions: Counter;
  requests: Counter;
  compactions: Counter;
  /** Wall time a session spent `busy`, seconds. */
  activeTime: Counter;
  linesOfCode: Counter;
  toolInvocations: Counter;
  permissionDecisions: Counter;
  commands: Counter;
}

export function createInstruments(meter: Meter): Instruments {
  return {
    cost: meter.createCounter("opencode.cost.usage", {
      description: "Cost of model usage, as reported by the OpenCode host",
      unit: "USD"
    }),
    tokens: meter.createHistogram("gen_ai.client.token.usage", {
      description: "Tokens consumed per assistant message, by token type",
      unit: "{token}"
    }),
    duration: meter.createHistogram("gen_ai.client.operation.duration", {
      description: "Duration of a model operation",
      unit: "s"
    }),
    sessions: meter.createCounter("opencode.session.count", {
      description: "Sessions started",
      unit: "{session}"
    }),
    requests: meter.createCounter("opencode.session.request.count", {
      description: "Assistant messages completed",
      unit: "{request}"
    }),
    compactions: meter.createCounter("opencode.session.compaction.count", {
      description: "Context compactions performed",
      unit: "{compaction}"
    }),
    activeTime: meter.createCounter("opencode.active_time.total", {
      description: "Wall time sessions spent busy",
      unit: "s"
    }),
    linesOfCode: meter.createCounter("opencode.lines_of_code.count", {
      description: "Lines added or removed across session diffs",
      unit: "{line}"
    }),
    toolInvocations: meter.createCounter("opencode.tool.invocations", {
      description: "Tool executions",
      unit: "{invocation}"
    }),
    permissionDecisions: meter.createCounter("opencode.permission.decision.count", {
      description: "Permission prompts resolved",
      unit: "{decision}"
    }),
    commands: meter.createCounter("opencode.command.executed.count", {
      description: "Slash commands executed",
      unit: "{command}"
    })
  };
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  dart: "dart",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  m: "objective-c",
  mm: "objective-c",
  scala: "scala",
  ex: "elixir",
  exs: "elixir",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  html: "html",
  css: "css",
  scss: "scss",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  tf: "terraform"
};

/** Best-effort language for a path, by extension. `undefined` when unknown. */
export function detectLanguage(file: string): string | undefined {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return undefined;
  }
  return EXTENSION_LANGUAGES[base.slice(dot + 1).toLowerCase()];
}
