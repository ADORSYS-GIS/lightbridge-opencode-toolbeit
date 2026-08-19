import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface OAuthCallbackResult {
  code: string;
  state: string;
}

export interface LocalCallbackServer {
  redirectUri: string;
  waitForCode: (timeoutMs?: number) => Promise<OAuthCallbackResult>;
  close: () => Promise<void>;
}

function writeHtml(response: ServerResponse, statusCode: number, body: string): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(body);
}

function parseCallback(request: IncomingMessage): OAuthCallbackResult | undefined {
  if (!request.url) {
    return undefined;
  }

  const url = new URL(request.url, "http://127.0.0.1");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return undefined;
  }

  return { code, state };
}

export async function startLocalCallbackServer(
  callbackPath = "/oauth2/callback",
  port?: number
): Promise<LocalCallbackServer> {
  let resolver: ((value: OAuthCallbackResult) => void) | undefined;
  let rejecter: ((reason?: unknown) => void) | undefined;

  const promise = new Promise<OAuthCallbackResult>((resolve, reject) => {
    resolver = resolve;
    rejecter = reject;
  });

  const server = createServer((request, response) => {
    const requestUrl = request.url ?? "";
    const parsed = new URL(requestUrl, "http://127.0.0.1");

    if (parsed.pathname !== callbackPath) {
      writeHtml(response, 404, "<h1>Not Found</h1>");
      return;
    }

    const payload = parseCallback(request);
    if (!payload) {
      writeHtml(response, 400, "<h1>Invalid OAuth callback</h1>");
      rejecter?.(new Error("invalid oauth callback payload"));
      return;
    }

    writeHtml(response, 200, "<h1>Login complete</h1><p>You can close this tab.</p>");
    resolver?.(payload);
  });

  const listenPort = typeof port === "number" && port >= 0 ? port : 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate local callback port");
  }

  return {
    redirectUri: `http://127.0.0.1:${address.port}${callbackPath}`,
    waitForCode(timeoutMs = 120_000) {
      return new Promise<OAuthCallbackResult>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("timed out waiting for OAuth callback"));
        }, timeoutMs);

        promise
          .then((value) => {
            clearTimeout(timeout);
            resolve(value);
          })
          .catch((error) => {
            clearTimeout(timeout);
            reject(error);
          });
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
