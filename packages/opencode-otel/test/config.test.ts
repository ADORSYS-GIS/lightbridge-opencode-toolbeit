import { describe, expect, it } from "vitest";

import { parseCommand, parseKeyValueList, resolveOtelConfig, signalUrl } from "../src/config.js";

describe("resolveOtelConfig", () => {
  it("is completely inert when nothing is configured", () => {
    const config = resolveOtelConfig(undefined, {});
    expect(config.enabled).toBe(true);
    expect(config.active).toBe(false);
    expect(config.exporters).toEqual({ traces: "none", metrics: "none", logs: "none" });
  });

  it("turns every signal on once an endpoint appears in plugin options", () => {
    const config = resolveOtelConfig({ endpoint: "http://collector:4318" }, {});
    expect(config.active).toBe(true);
    expect(config.exporters).toEqual({ traces: "otlp", metrics: "otlp", logs: "otlp" });
  });

  it("activates for a console exporter with no endpoint at all", () => {
    const config = resolveOtelConfig({ exporters: { logs: "console" } }, {});
    expect(config.active).toBe(true);
    expect(config.exporters.logs).toBe("console");
    expect(config.exporters.traces).toBe("none");
  });

  it("lets the environment override plugin options", () => {
    const config = resolveOtelConfig(
      { endpoint: "http://served:4318", serviceName: "from-config" },
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
        OTEL_SERVICE_NAME: "from-env"
      }
    );
    expect(config.endpoint).toBe("http://localhost:4318");
    expect(config.serviceName).toBe("from-env");
  });

  it("merges headers key-by-key instead of replacing the map", () => {
    const config = resolveOtelConfig(
      { headers: { "x-tenant": "acme", authorization: "served" } },
      { OTEL_EXPORTER_OTLP_HEADERS: "authorization=local" }
    );
    expect(config.headers).toEqual({ "x-tenant": "acme", authorization: "local" });
  });

  it("honours a per-signal exporter override from the environment", () => {
    const config = resolveOtelConfig(
      { endpoint: "http://collector:4318" },
      { OTEL_METRICS_EXPORTER: "none", OTEL_LOGS_EXPORTER: "console" }
    );
    expect(config.exporters).toEqual({ traces: "otlp", metrics: "none", logs: "console" });
  });

  it("can be disabled entirely from the environment", () => {
    const config = resolveOtelConfig(
      { endpoint: "http://collector:4318" },
      { OPENCODE_OTEL_ENABLED: "0" }
    );
    expect(config.enabled).toBe(false);
    expect(config.active).toBe(false);
  });

  it("keeps session id off metrics unless asked", () => {
    expect(resolveOtelConfig({}, {}).includeSessionId).toBe(false);
    expect(resolveOtelConfig({ includeSessionId: true }, {}).includeSessionId).toBe(true);
    expect(
      resolveOtelConfig({ includeSessionId: true }, { OTEL_METRICS_INCLUDE_SESSION_ID: "false" })
        .includeSessionId
    ).toBe(false);
  });

  it("accepts filtered tools as an array or a comma list", () => {
    expect([...resolveOtelConfig({ filteredTools: ["read", "glob"] }, {}).filteredTools]).toEqual([
      "read",
      "glob"
    ]);
    expect([
      ...resolveOtelConfig({}, { OTEL_OPENCODE_FILTERED_TOOLS: "read, glob ,grep" }).filteredTools
    ]).toEqual(["read", "glob", "grep"]);
  });

  it("reads export intervals from both the spec name and the Claude Code alias", () => {
    expect(
      resolveOtelConfig({}, { OTEL_METRIC_EXPORT_INTERVAL: "15000" }).metricExportIntervalMs
    ).toBe(15_000);
    expect(resolveOtelConfig({}, { OTEL_BSP_SCHEDULE_DELAY: "250" }).traceExportIntervalMs).toBe(
      250
    );
    expect(resolveOtelConfig({}, { OTEL_LOGS_EXPORT_INTERVAL: "750" }).logExportIntervalMs).toBe(
      750
    );
  });

  it("ignores a non-positive interval and falls back to the default", () => {
    expect(resolveOtelConfig({ metricExportIntervalMs: -5 }, {}).metricExportIntervalMs).toBe(
      60_000
    );
    expect(
      resolveOtelConfig({}, { OTEL_METRIC_EXPORT_INTERVAL: "abc" }).metricExportIntervalMs
    ).toBe(60_000);
  });

  it("defaults temporality to delta and accepts an explicit preference", () => {
    expect(resolveOtelConfig({}, {}).metricTemporality).toBe("delta");
    expect(
      resolveOtelConfig(
        { metricTemporality: "delta" },
        { OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: "cumulative" }
      ).metricTemporality
    ).toBe("cumulative");
  });

  it("disables trace propagation when traces are off", () => {
    expect(resolveOtelConfig({ endpoint: "http://c:4318" }, {}).propagateTraceContext).toBe(true);
    expect(
      resolveOtelConfig({ endpoint: "http://c:4318", exporters: { traces: "none" } }, {})
        .propagateTraceContext
    ).toBe(false);
  });
});

describe("parseKeyValueList", () => {
  it("parses and percent-decodes pairs", () => {
    expect(parseKeyValueList("a=1,b=hello%20world")).toEqual({ a: "1", b: "hello world" });
  });

  it("keeps an undecodable value verbatim rather than dropping the pair", () => {
    expect(parseKeyValueList("token=abc%")).toEqual({ token: "abc%" });
  });

  it("skips malformed entries", () => {
    expect(parseKeyValueList("novalue,=orphan,ok=1")).toEqual({ ok: "1" });
  });

  it("returns an empty object for empty input", () => {
    expect(parseKeyValueList(undefined)).toEqual({});
  });
});

describe("signalUrl", () => {
  it("appends the signal path to a base endpoint", () => {
    const config = resolveOtelConfig({ endpoint: "http://localhost:4318/" }, {});
    expect(signalUrl(config, "traces")).toBe("http://localhost:4318/v1/traces");
    expect(signalUrl(config, "metrics")).toBe("http://localhost:4318/v1/metrics");
    expect(signalUrl(config, "logs")).toBe("http://localhost:4318/v1/logs");
  });

  it("uses a per-signal endpoint verbatim", () => {
    const config = resolveOtelConfig(
      { endpoint: "http://base:4318", endpoints: { logs: "https://logs.example/ingest" } },
      {}
    );
    expect(signalUrl(config, "logs")).toBe("https://logs.example/ingest");
  });

  it("returns undefined with no endpoint configured", () => {
    expect(signalUrl(resolveOtelConfig({}, {}), "traces")).toBeUndefined();
  });
});

describe("credential helper", () => {
  it("is absent unless configured", () => {
    expect(resolveOtelConfig({}, {}).tokenCommand).toEqual([]);
  });

  it("splits a string command on whitespace", () => {
    expect(resolveOtelConfig({ tokenCommand: "governance-auth token" }, {}).tokenCommand).toEqual([
      "governance-auth",
      "token"
    ]);
  });

  it("keeps an argv array intact, so a path may contain spaces", () => {
    expect(
      resolveOtelConfig({ tokenCommand: ["/opt/my tools/governance-auth", "token"] }, {})
        .tokenCommand
    ).toEqual(["/opt/my tools/governance-auth", "token"]);
  });

  it("lets the environment override the command", () => {
    expect(
      resolveOtelConfig(
        { tokenCommand: "from-config" },
        { OPENCODE_OTEL_TOKEN_COMMAND: "from-env token" }
      ).tokenCommand
    ).toEqual(["from-env", "token"]);
  });

  it("splits an environment override even when config supplied the array form", () => {
    // The documented `.well-known` shape: an org ships argv, a machine overrides
    // with the string form. Deciding the split from the config value rather than
    // the value actually used produced one argv element with a space inside the
    // executable name — `execFile` then failed to spawn and every export went
    // out with no Authorization header.
    expect(
      resolveOtelConfig(
        { tokenCommand: ["governance-auth", "token"] },
        { OPENCODE_OTEL_TOKEN_COMMAND: "governance-auth token" }
      ).tokenCommand
    ).toEqual(["governance-auth", "token"]);
  });

  it("keeps the config array intact when no environment override is present", () => {
    expect(
      resolveOtelConfig({ tokenCommand: ["/opt/my tools/helper", "token"] }, {}).tokenCommand
    ).toEqual(["/opt/my tools/helper", "token"]);
  });

  it("defaults the header, prefix and refresh cadence", () => {
    const config = resolveOtelConfig({ tokenCommand: "helper" }, {});
    expect(config.tokenHeader).toBe("Authorization");
    expect(config.tokenPrefix).toBe("Bearer ");
    expect(config.tokenRefreshMs).toBe(240_000);
    expect(config.tokenTimeoutMs).toBe(10_000);
  });

  it("accepts an empty prefix for a raw API-key header", () => {
    const config = resolveOtelConfig(
      { tokenCommand: "helper", tokenHeader: "x-api-key", tokenPrefix: "" },
      {}
    );
    expect(config.tokenHeader).toBe("x-api-key");
    expect(config.tokenPrefix).toBe("");
  });

  it("takes the refresh cadence from the environment", () => {
    expect(resolveOtelConfig({}, { OPENCODE_OTEL_TOKEN_REFRESH_MS: "60000" }).tokenRefreshMs).toBe(
      60_000
    );
  });
});

describe("parseCommand", () => {
  it("splits a string on any run of whitespace", () => {
    expect(parseCommand("governance-auth   token")).toEqual(["governance-auth", "token"]);
    expect(parseCommand("  helper\ttoken  ")).toEqual(["helper", "token"]);
  });

  it("takes an array verbatim, so a path may contain spaces", () => {
    expect(parseCommand(["/opt/my tools/helper", "token"])).toEqual([
      "/opt/my tools/helper",
      "token"
    ]);
  });

  it("drops non-string and blank array entries", () => {
    expect(parseCommand(["helper", "", 42, null, "  ", "token"])).toEqual(["helper", "token"]);
  });

  it("returns nothing for anything else", () => {
    expect(parseCommand(undefined)).toEqual([]);
    expect(parseCommand("")).toEqual([]);
    expect(parseCommand("   ")).toEqual([]);
    expect(parseCommand(42)).toEqual([]);
    expect(parseCommand({ command: "helper" })).toEqual([]);
  });

  it("does not treat a comma as a separator — a command is not a list", () => {
    expect(parseCommand("helper,token")).toEqual(["helper,token"]);
  });
});
