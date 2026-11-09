import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveStateRoot, validateAuthConfig } from "@vymalo/opencode-auth-core/lib";
import { describe, expect, it } from "vitest";

// The real oauth2 plugin, imported by relative path on purpose: lightbridge
// does not depend on oauth2 (ADR-0017 pins the shared literals instead), so this
// is the one place that proves the two sides still agree on the file.
import { resolveStateDir as oauth2StateDir } from "../../opencode-oauth2/src/cache.js";
import { OAuth2ModelSyncPlugin } from "../../opencode-oauth2/src/plugin.js";
import {
  LightbridgeRuntime,
  ROOT_CACHE_NAMESPACE,
  ROOT_CACHE_SEGMENT,
  rootStateDir
} from "../src/plugin.js";
import { createSilentLogger, makeAuth, makeJsonResponse } from "./helpers.js";

describe("oauth2 and lightbridge share ONE credential file (ADR-0017, ADR-0022)", () => {
  it("resolve the same root-token directory for the same auth.id", () => {
    // oauth2's `opencode.ts` default namespace; lightbridge pins the same literal.
    expect(rootStateDir(resolveStateRoot())).toBe(oauth2StateDir(ROOT_CACHE_NAMESPACE));
    expect(oauth2StateDir(ROOT_CACHE_NAMESPACE)).toBe(
      join(resolveStateRoot(), "opencode-oauth2", "opencode-oauth2-model-sync")
    );
    expect(ROOT_CACHE_SEGMENT).toBe("opencode-oauth2");
  });

  it("a login performed by the real oauth2 plugin is read by lightbridge with no re-login", async () => {
    const auth = makeAuth({
      id: "shared-gw",
      authFlow: "client_credentials",
      clientSecret: "s3cr3t"
    });
    // The vitest setup file isolated HOME: default dirs, no injection, throwaway home.
    const oauth2 = new OAuth2ModelSyncPlugin(
      {
        servers: [
          {
            id: "shared-gw",
            name: "shared-gw",
            issuer: auth.issuer,
            baseURL: "https://gateway.example.com/v1",
            clientId: auth.clientId,
            clientSecret: "s3cr3t",
            scopes: auth.scopes ?? ["openid"],
            tokenEndpoint: auth.tokenEndpoint,
            authFlow: "client_credentials"
          }
        ],
        cacheNamespace: ROOT_CACHE_NAMESPACE
      },
      {
        logger: createSilentLogger(),
        fetchImpl: (async (input: unknown) => {
          const url = String(input);
          return url.includes("/models")
            ? makeJsonResponse({ data: [{ id: "glm-5" }] })
            : makeJsonResponse({
                access_token: "oauth2-login",
                token_type: "Bearer",
                expires_in: 3600
              });
        }) as unknown as typeof fetch
      }
    );
    await oauth2.initialize();
    await oauth2.syncServer("shared-gw");

    const file = join(rootStateDir(resolveStateRoot()), "shared-gw.json");
    expect(await readFile(file, "utf8")).toContain("oauth2-login");

    const lightbridge = new LightbridgeRuntime(validateAuthConfig(auth), undefined, {
      logger: createSilentLogger(),
      fetchImpl: async () => {
        throw new Error("no login expected — oauth2 already logged in for this shared identity");
      }
    });
    expect((await lightbridge.getProjectToken()).accessToken).toBe("oauth2-login");
  });
});
