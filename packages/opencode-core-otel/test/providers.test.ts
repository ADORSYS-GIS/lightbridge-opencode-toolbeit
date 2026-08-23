import { describe, expect, it } from "vitest";

import { resolveOtelConfig } from "../src/config.js";
import { buildResource, createProviders, describeError } from "../src/providers.js";
import { silentLogger } from "./helpers.js";

const base = () => resolveOtelConfig({ endpoint: "http://localhost:4318" }, {});

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
});

describe("describeError", () => {
  it("unwraps an Error and stringifies anything else", () => {
    expect(describeError(new Error("nope"))).toBe("nope");
    expect(describeError("plain")).toBe("plain");
  });
});
