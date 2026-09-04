import { ExportResultCode } from "@opentelemetry/core";
import type { SpanExporter } from "@opentelemetry/sdk-trace";
import { describe, expect, it, vi } from "vitest";

import { resolveOtelConfig } from "../src/config.js";
import { buildResource, createProviders, describeError } from "../src/providers.js";
import type { TokenSource } from "../src/token-source.js";
import { silentLogger } from "./helpers.js";

const base = () => resolveOtelConfig({ endpoint: "http://localhost:4318" }, {});

/** A minimal `SpanExporter` whose `export` calls are individually observable. */
function spySpanExporter(): { exporter: SpanExporter; exportSpy: ReturnType<typeof vi.fn> } {
  const exportSpy = vi.fn((_spans: unknown, resultCallback: (result: unknown) => void) => {
    resultCallback({ code: ExportResultCode.SUCCESS });
  });
  return {
    exporter: { export: exportSpy, shutdown: async () => {} } as unknown as SpanExporter,
    exportSpy
  };
}

function fixedTokenSource(headers: Record<string, string> | undefined): TokenSource {
  return { headers: async () => headers, invalidate: () => {} };
}

describe("buildResource", () => {
  it("identifies the machine and project, never the developer", () => {
    const attributes = buildResource(base(), {
      version: "1.2.3",
      hostname: "workstation",
      projectName: "toolbelt",
      directory: "/repo",
      worktree: "/repo",
      branch: "main"
    }).attributes;

    expect(attributes["service.name"]).toBe("opencode");
    expect(attributes["service.version"]).toBe("1.2.3");
    expect(attributes["host.name"]).toBe("workstation");
    expect(attributes["opencode.project.name"]).toBe("toolbelt");
    expect(attributes["vcs.repository.ref.name"]).toBe("main");
    // No git identity is ever collected implicitly.
    expect(attributes["enduser.id"]).toBeUndefined();
    expect(attributes["host.user.email"]).toBeUndefined();
  });

  it("omits attributes it has no value for", () => {
    const attributes = buildResource(base(), {}).attributes;
    expect(attributes["host.name"]).toBeUndefined();
    expect(attributes["opencode.project.name"]).toBeUndefined();
  });

  it("stamps the deployment environment", () => {
    const config = resolveOtelConfig({ endpoint: "http://c:4318", environment: "staging" }, {});
    expect(buildResource(config, {}).attributes["deployment.environment.name"]).toBe("staging");
  });

  it("lets operator attributes win over the defaults", () => {
    const config = resolveOtelConfig(
      { endpoint: "http://c:4318", resourceAttributes: { "service.name": "custom", team: "eng" } },
      {}
    );
    const attributes = buildResource(config, { hostname: "h" }).attributes;
    expect(attributes["service.name"]).toBe("custom");
    expect(attributes.team).toBe("eng");
  });
});

describe("createProviders", () => {
  it("builds nothing for signals whose exporter is none", () => {
    const config = resolveOtelConfig(
      { endpoint: "http://c:4318", exporters: { traces: "none", metrics: "none" } },
      {}
    );
    const providers = createProviders(config, buildResource(config, {}), silentLogger(), {
      log: () => undefined
    });
    expect(providers.tracer).toBeUndefined();
    expect(providers.meter).toBeUndefined();
  });

  it("keeps the other signals alive when one fails to build", () => {
    const logger = silentLogger();
    const providers = createProviders(base(), buildResource(base(), {}), logger, {
      trace: () => {
        throw new Error("boom");
      }
    });
    expect(providers.tracer).toBeUndefined();
    expect(providers.meter).toBeDefined();
    expect(providers.otelLogger).toBeDefined();
    expect(logger.events.some(([name]) => name === "warn:otel_traces_init_failed")).toBe(true);
  });

  it("flushes and shuts down without throwing when nothing is configured", async () => {
    const config = resolveOtelConfig({}, {});
    const providers = createProviders(config, buildResource(config, {}), silentLogger());
    await expect(providers.forceFlush()).resolves.toBeUndefined();
    await expect(providers.shutdown()).resolves.toBeUndefined();
  });

  it("constructs real OTLP exporters from an endpoint", () => {
    const providers = createProviders(base(), buildResource(base(), {}), silentLogger());
    expect(providers.tracer).toBeDefined();
    expect(providers.meter).toBeDefined();
    expect(providers.otelLogger).toBeDefined();
  });

  it("supports console exporters with no endpoint", () => {
    const config = resolveOtelConfig(
      { exporters: { traces: "console", metrics: "console", logs: "console" } },
      {}
    );
    const providers = createProviders(config, buildResource(config, {}), silentLogger());
    expect(providers.tracer).toBeDefined();
    expect(providers.otelLogger).toBeDefined();
  });

  describe("fail-closed credential gate (ADR-0015)", () => {
    it("never reaches the underlying OTLP exporter when the injected token source has no credential", async () => {
      const { exporter, exportSpy } = spySpanExporter();
      const providers = createProviders(
        base(),
        buildResource(base(), {}),
        silentLogger(),
        { trace: () => exporter },
        fixedTokenSource(undefined)
      );

      providers.tracer?.startSpan("op").end();
      await providers.forceFlush();

      expect(exportSpy).not.toHaveBeenCalled();
    });

    it("reaches the underlying OTLP exporter once the injected token source resolves a credential", async () => {
      const { exporter, exportSpy } = spySpanExporter();
      const providers = createProviders(
        base(),
        buildResource(base(), {}),
        silentLogger(),
        { trace: () => exporter },
        fixedTokenSource({ Authorization: "Bearer good-token" })
      );

      providers.tracer?.startSpan("op").end();
      await providers.forceFlush();

      expect(exportSpy).toHaveBeenCalledTimes(1);
    });

    it("does not gate a console exporter on the token source", async () => {
      // A console exporter never leaves the process, so it must keep printing
      // locally even while the network credential is unusable.
      const config = resolveOtelConfig({ exporters: { traces: "console" } }, {});
      const { exporter, exportSpy } = spySpanExporter();
      const providers = createProviders(
        config,
        buildResource(config, {}),
        silentLogger(),
        { trace: () => exporter }, // stands in for the real ConsoleSpanExporter
        fixedTokenSource(undefined)
      );

      providers.tracer?.startSpan("op").end();
      await providers.forceFlush();

      expect(exportSpy).toHaveBeenCalledTimes(1);
    });

    it("exports normally with no token source at all — the standalone unauthenticated case", async () => {
      // Regression guard: `@vymalo/opencode-otel` with no `tokenCommand` and no
      // injected source must keep exporting exactly as before this change.
      const { exporter, exportSpy } = spySpanExporter();
      const providers = createProviders(base(), buildResource(base(), {}), silentLogger(), {
        trace: () => exporter
      });

      providers.tracer?.startSpan("op").end();
      await providers.forceFlush();

      expect(exportSpy).toHaveBeenCalledTimes(1);
    });
  });
});

describe("describeError", () => {
  it("unwraps an Error and stringifies anything else", () => {
    expect(describeError(new Error("nope"))).toBe("nope");
    expect(describeError("plain")).toBe("plain");
  });
});
