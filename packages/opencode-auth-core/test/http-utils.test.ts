import { describe, expect, it } from "vitest";

import { readResponseBodyPreview, redactUrl, scrubSecrets } from "../src/oauth/http-utils.js";

describe("redactUrl", () => {
  it("strips userinfo", () => {
    expect(redactUrl("https://user:pass@api.example.com/v1/models")).toBe(
      "https://api.example.com/v1/models"
    );
  });

  it("strips the query string and hash", () => {
    expect(redactUrl("https://api.example.com/v1/models?token=abc#frag")).toBe(
      "https://api.example.com/v1/models"
    );
  });

  it("preserves the path", () => {
    expect(redactUrl("https://api.example.com/v1/models")).toBe(
      "https://api.example.com/v1/models"
    );
  });

  it("falls back gracefully for non-URL strings", () => {
    expect(redactUrl("not-a-url?query=secret")).toBe("not-a-url");
  });
});

describe("readResponseBodyPreview", () => {
  it("returns the body when within the cap", async () => {
    const response = new Response("hello", { status: 500 });
    expect(await readResponseBodyPreview(response, 100)).toBe("hello");
  });

  it("caps the returned text at maxChars", async () => {
    const big = "x".repeat(5000);
    const response = new Response(big, { status: 500 });
    const preview = await readResponseBodyPreview(response, 200);
    expect(preview.length).toBeLessThanOrEqual(200);
    expect(preview.startsWith("x")).toBe(true);
  });

  it("returns an empty string when the body is empty", async () => {
    const response = new Response("", { status: 500 });
    expect(await readResponseBodyPreview(response, 100)).toBe("");
  });
});

describe("scrubSecrets", () => {
  it("masks secret-named JSON values", () => {
    const input =
      '{"error":"invalid_grant","access_token":"AT-1234","refresh_token":"RT-5678","client_secret":"CS-9999"}';
    const out = scrubSecrets(input);
    expect(out).not.toContain("AT-1234");
    expect(out).not.toContain("RT-5678");
    expect(out).not.toContain("CS-9999");
    expect(out).toContain("invalid_grant");
  });

  it("masks form-encoded secret values", () => {
    const input = "grant_type=client_credentials&client_id=cid&client_secret=hunter2";
    const out = scrubSecrets(input);
    expect(out).not.toContain("hunter2");
    expect(out).toContain("client_id=cid");
    expect(out).toContain("grant_type=client_credentials");
  });

  it("masks Bearer headers and bare JWT-shaped tokens", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature-bytes-here";
    const input = `Authorization: Bearer ${jwt} — invalid token`;
    const out = scrubSecrets(input);
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("signature-bytes-here");
    expect(out).toContain("invalid token");
  });

  it("leaves non-secret text unchanged", () => {
    const input = "Bad request: missing scope 'openid'";
    expect(scrubSecrets(input)).toBe(input);
  });
});
