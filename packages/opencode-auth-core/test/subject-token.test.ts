import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveSubjectToken } from "../src/oauth/subject-token.js";

describe("resolveSubjectToken", () => {
  it("reads a file and trims whitespace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subject-token-"));
    const path = join(dir, "token");
    await writeFile(path, "  abc.def.ghi  \n", "utf8");

    const token = await resolveSubjectToken({ type: "file", path });
    expect(token).toBe("abc.def.ghi");
  });

  it("throws a helpful error when the file does not exist", async () => {
    await expect(
      resolveSubjectToken({ type: "file", path: "/tmp/definitely-not-here-xyz" })
    ).rejects.toThrow(/no file at/);
  });

  it("throws when the file is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subject-token-empty-"));
    const path = join(dir, "token");
    await writeFile(path, "   \n", "utf8");

    await expect(resolveSubjectToken({ type: "file", path })).rejects.toThrow(/is empty/);
  });

  it("uses the default kubernetes_sa path when none is configured", async () => {
    await expect(resolveSubjectToken({ type: "kubernetes_sa" })).rejects.toThrow(
      /\/var\/run\/secrets\/tokens\/oauth2\/token/
    );
  });

  it("reads an env var", async () => {
    const token = await resolveSubjectToken(
      { type: "env", var: "TEST_OIDC_JWT" },
      { env: { TEST_OIDC_JWT: "  envvar-jwt  " } }
    );
    expect(token).toBe("envvar-jwt");
  });

  it("throws when the env var is unset", async () => {
    await expect(
      resolveSubjectToken({ type: "env", var: "DEFINITELY_NOT_SET_XYZ" }, { env: {} })
    ).rejects.toThrow(/is not set or is empty/);
  });

  it("fetches the GitHub Actions OIDC token", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedAuth = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ value: "gha-jwt-xyz" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    const token = await resolveSubjectToken(
      { type: "github_actions", audience: "https://auth.example.com/realms/test" },
      {
        fetchImpl,
        env: {
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://gha-oidc.example.com/token",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token-abc"
        }
      }
    );

    expect(token).toBe("gha-jwt-xyz");
    expect(capturedUrl).toContain("audience=https%3A%2F%2Fauth.example.com%2Frealms%2Ftest");
    expect(capturedAuth).toBe("Bearer runner-token-abc");
  });

  it("throws when GHA env vars are missing (running outside an Actions job)", async () => {
    await expect(
      resolveSubjectToken({ type: "github_actions", audience: "x" }, { env: {} })
    ).rejects.toThrow(/ACTIONS_ID_TOKEN_REQUEST_URL/);
  });

  it("surfaces the response body (scrubbed) when GHA returns non-2xx", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response('{"message":"audience not allowed"}', {
        status: 403,
        headers: { "Content-Type": "application/json" }
      })) as typeof fetch;

    await expect(
      resolveSubjectToken(
        { type: "github_actions", audience: "x" },
        {
          fetchImpl,
          env: {
            ACTIONS_ID_TOKEN_REQUEST_URL: "https://gha-oidc.example.com/token",
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t"
          }
        }
      )
    ).rejects.toThrow(/403.*audience not allowed/);
  });
});
