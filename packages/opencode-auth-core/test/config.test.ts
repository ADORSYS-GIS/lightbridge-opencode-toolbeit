import { describe, expect, it } from "vitest";

import { DEFAULT_AUTH_FLOW, validateAuthConfig } from "../src/config.js";

describe("validateAuthConfig", () => {
  it("normalizes a minimal config and applies the default auth flow", () => {
    const config = validateAuthConfig({
      id: "srv",
      issuer: "https://auth.example.com",
      clientId: "opencode-client",
      scopes: ["openid"]
    });

    expect(config.id).toBe("srv");
    expect(config.issuer).toBe("https://auth.example.com");
    expect(config.clientId).toBe("opencode-client");
    expect(config.scopes).toEqual(["openid"]);
    expect(config.authFlow).toBe(DEFAULT_AUTH_FLOW);
    expect(config.pkce).toBe(true);
  });

  it("requires clientSecret for client_credentials", () => {
    expect(() =>
      validateAuthConfig({
        id: "srv",
        issuer: "https://auth.example.com",
        clientId: "c",
        scopes: ["openid"],
        authFlow: "client_credentials"
      })
    ).toThrow(/clientSecret is required/);
  });

  it("requires subjectTokenSource for token_exchange and jwt_bearer", () => {
    expect(() =>
      validateAuthConfig({
        id: "srv",
        issuer: "https://auth.example.com",
        clientId: "c",
        scopes: ["openid"],
        authFlow: "token_exchange"
      })
    ).toThrow(/subjectTokenSource is required/);

    expect(() =>
      validateAuthConfig({
        id: "srv",
        issuer: "https://auth.example.com",
        clientId: "c",
        scopes: ["openid"],
        authFlow: "jwt_bearer"
      })
    ).toThrow(/subjectTokenSource is required/);
  });

  it("accepts a subject token source and audience for token_exchange", () => {
    const config = validateAuthConfig({
      id: "srv",
      issuer: "https://auth.example.com",
      clientId: "c",
      scopes: ["openid"],
      authFlow: "token_exchange",
      subjectTokenSource: { type: "env", var: "PLATFORM_JWT" },
      tokenExchangeAudience: "/sources/src-123"
    });

    expect(config.subjectTokenSource).toEqual({ type: "env", var: "PLATFORM_JWT" });
    expect(config.tokenExchangeAudience).toBe("/sources/src-123");
  });

  it("rejects a malformed subjectTokenSource type", () => {
    expect(() =>
      validateAuthConfig({
        id: "srv",
        issuer: "https://auth.example.com",
        clientId: "c",
        scopes: ["openid"],
        authFlow: "token_exchange",
        subjectTokenSource: { type: "nope", var: "X" } as never
      })
    ).toThrow(/must be one of/);
  });
});
