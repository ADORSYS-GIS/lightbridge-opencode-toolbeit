import { describe, expect, it } from "vitest";

import { hasOAuth2Conflict, parseRepoAuthSettings } from "../src/config.js";

describe("parseRepoAuthSettings", () => {
  it("returns not_opted_in when there are no settings", () => {
    expect(parseRepoAuthSettings(undefined)).toEqual({ kind: "not_opted_in" });
    expect(parseRepoAuthSettings({ timeout: 1000 })).toEqual({ kind: "not_opted_in" });
  });

  it("does not read the v1 options.meta location", () => {
    expect(parseRepoAuthSettings({ meta: { repoAuth: { projectId: "proj-123" } } })).toEqual({
      kind: "not_opted_in"
    });
  });

  it("returns missing_project_id when the block lacks projectId", () => {
    const result = parseRepoAuthSettings({ repoAuth: { issuer: "https://x.test" } });
    expect(result).toEqual({ kind: "missing_project_id" });
  });

  it("parses a full opt-in into a RepoAuthConfig", () => {
    const result = parseRepoAuthSettings({
      timeout: 1000,
      repoAuth: {
        projectId: "proj-123",
        issuer: "https://idp.example.com/realms/acme",
        clientId: "opencode-cli",
        scopes: ["openid", "offline_access"],
        authFlow: "device_code",
        tokenEndpoint: "https://idp.example.com/token",
        deviceAuthorizationEndpoint: "https://idp.example.com/device",
        pkce: false
      }
    });

    expect(result.kind).toBe("opted_in");
    if (result.kind !== "opted_in") {
      return;
    }
    expect(result.config.projectId).toBe("proj-123");
    expect(result.config.auth).toMatchObject({
      id: "repoAuth",
      issuer: "https://idp.example.com/realms/acme",
      clientId: "opencode-cli",
      scopes: ["openid", "offline_access"],
      authFlow: "device_code",
      tokenEndpoint: "https://idp.example.com/token",
      deviceAuthorizationEndpoint: "https://idp.example.com/device",
      pkce: false
    });
  });

  it("defaults authFlow and pkce to undefined so auth-core applies its defaults", () => {
    const result = parseRepoAuthSettings({
      repoAuth: {
        projectId: "proj-123",
        issuer: "https://idp.example.com",
        clientId: "opencode-cli",
        scopes: ["openid"]
      }
    });
    expect(result.kind).toBe("opted_in");
    if (result.kind !== "opted_in") {
      return;
    }
    expect(result.config.auth.authFlow).toBeUndefined();
    expect(result.config.auth.pkce).toBeUndefined();
  });

  it("throws a debuggable error for an invalid authFlow", () => {
    expect(() =>
      parseRepoAuthSettings({
        repoAuth: {
          projectId: "proj-123",
          issuer: "https://idp.example.com",
          clientId: "opencode-cli",
          scopes: ["openid"],
          authFlow: "password"
        }
      })
    ).toThrow(/provider\.settings\.repoAuth\.authFlow/);
  });

  it("throws when issuer/clientId/scopes are missing", () => {
    expect(() => parseRepoAuthSettings({ repoAuth: { projectId: "proj-123" } })).toThrow(
      /requires non-empty issuer, clientId and scopes/
    );
  });
});

describe("hasOAuth2Conflict", () => {
  it("is false without oauth2 markers", () => {
    expect(hasOAuth2Conflict({})).toBe(false);
    expect(hasOAuth2Conflict({ settings: { timeout: 1 } })).toBe(false);
  });

  it("is true for settings.oauth2 or settings.oauth2ModelSync blocks", () => {
    expect(
      hasOAuth2Conflict({
        settings: { oauth2: { issuer: "https://x.test", clientId: "c", scopes: ["s"] } }
      })
    ).toBe(true);
    expect(
      hasOAuth2Conflict({
        settings: { oauth2ModelSync: { issuer: "https://x.test", clientId: "c", scopes: ["s"] } }
      })
    ).toBe(true);
  });

  it("is true when the provider is owned by an Integration", () => {
    expect(hasOAuth2Conflict({ integrationID: "integration-1" })).toBe(true);
  });
});
