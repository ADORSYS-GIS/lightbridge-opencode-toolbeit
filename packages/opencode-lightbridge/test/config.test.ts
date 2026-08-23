import { describe, expect, it } from "vitest";

import { needsProjectToken, parseLightbridgeOptions } from "../src/config.js";
import { makeAuth } from "./helpers.js";

describe("parseLightbridgeOptions", () => {
  it("throws when options are not an object", () => {
    expect(() => parseLightbridgeOptions(undefined)).toThrow(/must be an object/);
    expect(() => parseLightbridgeOptions("nope")).toThrow(/must be an object/);
  });

  it("throws when `auth` is missing", () => {
    expect(() => parseLightbridgeOptions({})).toThrow(/auth is required/);
  });

  it("throws when `auth` is structurally invalid (validateAuthConfig)", () => {
    expect(() =>
      parseLightbridgeOptions({ auth: { id: "x", issuer: "", clientId: "c", scopes: ["s"] } })
    ).toThrow(/issuer must be a non-empty string/);
  });

  it("parses an auth-only config as valid with no gateway/otel/projectId", () => {
    const parsed = parseLightbridgeOptions({ auth: makeAuth() });
    expect(parsed.gateway).toBeUndefined();
    expect(parsed.otel).toBeUndefined();
    expect(parsed.projectId).toBeUndefined();
    expect(needsProjectToken(parsed)).toBe(false);
  });

  it("parses a gateway block and resolves projectId from it", () => {
    const parsed = parseLightbridgeOptions({
      auth: makeAuth(),
      gateway: { projectId: "proj-123", providers: ["gateway"] }
    });
    expect(parsed.gateway).toEqual({ projectId: "proj-123", providers: ["gateway"] });
    expect(parsed.projectId).toBe("proj-123");
    expect(needsProjectToken(parsed)).toBe(true);
  });

  it("parses a gateway block with no projectId (default project)", () => {
    const parsed = parseLightbridgeOptions({
      auth: makeAuth(),
      gateway: { providers: ["gateway"] }
    });
    expect(parsed.gateway).toEqual({ providers: ["gateway"] });
    expect(parsed.projectId).toBeUndefined();
  });

  it("throws on a malformed gateway block (empty providers)", () => {
    expect(() =>
      parseLightbridgeOptions({ auth: makeAuth(), gateway: { projectId: "p", providers: [] } })
    ).toThrow(/gateway\.providers/);
  });

  it("parses an otel-only config, needing a project token but with no gateway projectId", () => {
    const parsed = parseLightbridgeOptions({
      auth: makeAuth(),
      otel: { endpoint: "http://localhost:4318" }
    });
    expect(parsed.otel).toEqual({ endpoint: "http://localhost:4318" });
    expect(parsed.gateway).toBeUndefined();
    expect(parsed.projectId).toBeUndefined();
    expect(needsProjectToken(parsed)).toBe(true);
  });

  it("resolves projectId for otel from the top-level `projectId` field", () => {
    const parsed = parseLightbridgeOptions({
      auth: makeAuth(),
      otel: { endpoint: "http://localhost:4318" },
      projectId: "proj-999"
    });
    expect(parsed.projectId).toBe("proj-999");
  });

  it("prefers the explicit top-level projectId over gateway.projectId", () => {
    const parsed = parseLightbridgeOptions({
      auth: makeAuth(),
      gateway: { projectId: "proj-gw", providers: ["gateway"] },
      projectId: "proj-explicit"
    });
    expect(parsed.projectId).toBe("proj-explicit");
  });

  it("throws when `otel` is present but not an object", () => {
    expect(() => parseLightbridgeOptions({ auth: makeAuth(), otel: "nope" })).toThrow(
      /lightbridge\.otel must be an object/
    );
  });

  it("throws when `gateway` is present but not an object", () => {
    expect(() => parseLightbridgeOptions({ auth: makeAuth(), gateway: "nope" })).toThrow(
      /lightbridge\.gateway must be an object/
    );
  });
});
