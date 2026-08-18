import { describe, expect, it } from "vitest";

import { discoverOidcMetadata } from "../src/oauth/discovery.js";

describe("discoverOidcMetadata", () => {
  it("requires token_endpoint", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ issuer: "https://auth.example.com" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })) as typeof fetch;

    await expect(discoverOidcMetadata("https://auth.example.com", fetchImpl)).rejects.toThrow(
      /token_endpoint/
    );
  });

  it("accepts metadata that omits authorization_endpoint (RFC 8414, device-only servers)", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          issuer: "https://auth.example.com",
          token_endpoint: "https://auth.example.com/token",
          device_authorization_endpoint: "https://auth.example.com/device"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as typeof fetch;

    const metadata = await discoverOidcMetadata("https://auth.example.com", fetchImpl);
    expect(metadata.token_endpoint).toBe("https://auth.example.com/token");
    expect(metadata.authorization_endpoint).toBeUndefined();
    expect(metadata.device_authorization_endpoint).toBe("https://auth.example.com/device");
  });
});
