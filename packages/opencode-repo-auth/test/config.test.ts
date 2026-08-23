import { describe, expect, it } from "vitest";

import { hasOAuth2Conflict, parseRepoAuthOptions } from "../src/config.js";

describe("parseRepoAuthOptions", () => {
  it("returns not_opted_in when there is no meta block", () => {
    expect(parseRepoAuthOptions(undefined)).toEqual({ kind: "not_opted_in" });
    expect(parseRepoAuthOptions({ baseURL: "https://gateway.example.com/v1" })).toEqual({
      kind: "not_opted_in"
    });
  });

  it("returns not_opted_in when meta has no repoAuth block", () => {
    expect(parseRepoAuthOptions({ meta: { modelsInfoUrl: "/models" } })).toEqual({
      kind: "not_opted_in"
    });
  });

  it("returns missing_project_id when the block lacks projectId", () => {
    const result = parseRepoAuthOptions({ meta: { repoAuth: { issuer: "https://x.test" } } });
    expect(result).toEqual({ kind: "missing_project_id" });
  });

  it("parses a full opt-in into a RepoAuthConfig", () => {
    const result = parseRepoAuthOptions({
      baseURL: "https://gateway.example.com/v1",
      meta: {
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
    const result = parseRepoAuthOptions({
      meta: {
        repoAuth: {
          projectId: "proj-123",
          issuer: "https://idp.example.com",
          clientId: "opencode-cli",
          scopes: ["openid"]
        }
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
      parseRepoAuthOptions({
        meta: {
          repoAuth: {
            projectId: "proj-123",
            issuer: "https://idp.example.com",
            clientId: "opencode-cli",
            scopes: ["openid"],
            authFlow: "password"
          }
        }
      })
    ).toThrow(/provider\.options\.meta\.repoAuth\.authFlow/);
  });

  it("throws when issuer/clientId/scopes are missing", () => {
    expect(() =>
      parseRepoAuthOptions({
        meta: { repoAuth: { projectId: "proj-123" } }
      })
    ).toThrow(/requires non-empty issuer, clientId and scopes/);
  });
});

describe("hasOAuth2Conflict", () => {
  it("is false without oauth2 keys", () => {
    expect(hasOAuth2Conflict({}, { baseURL: "https://x.test" })).toBe(false);
    expect(hasOAuth2Conflict({}, undefined)).toBe(false);
  });

  it("is true for oauth2 or oauth2ModelSync blocks", () => {
    expect(
      hasOAuth2Conflict({}, { oauth2: { issuer: "https://x.test", clientId: "c", scopes: ["s"] } })
    ).toBe(true);
    expect(
      hasOAuth2Conflict(
        {},
        {
          oauth2ModelSync: { issuer: "https://x.test", clientId: "c", scopes: ["s"] }
        }
      )
    ).toBe(true);
  });

  it("is true when the provider id is managed via pluginConfig.oauth2ModelSync.servers", () => {
    const config = {
      pluginConfig: {
        oauth2ModelSync: {
          servers: [{ id: "gateway", issuer: "https://x.test", clientId: "c", scopes: ["s"] }]
        }
      }
    };
    expect(hasOAuth2Conflict(config, {}, "gateway")).toBe(true);
    expect(hasOAuth2Conflict(config, {}, "other-provider")).toBe(false);
    expect(hasOAuth2Conflict(config, undefined, "gateway")).toBe(true);
  });
});
