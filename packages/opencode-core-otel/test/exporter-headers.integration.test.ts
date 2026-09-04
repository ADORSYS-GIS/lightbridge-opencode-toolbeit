import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";

import { withFailureLogging } from "../src/export-logging.js";
import { createTokenSource } from "../src/token-source.js";
import { silentLogger } from "./helpers.js";

/**
 * These tests exercise the real `OTLPTraceExporter`, not a fake — the fakes
 * used elsewhere in this suite substitute the exporter entirely, so they
 * cannot tell us whether the SDK actually awaits an async `headers` factory
 * before writing the request. A server that saw no `Authorization` header
 * would mean every export goes out unauthenticated.
 */

interface RecordingServer {
  server: Server;
  url: string;
  authorizations: Array<string | undefined>;
}

function startRecordingServer(): Promise<RecordingServer> {
  const authorizations: Array<string | undefined> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    authorizations.push(req.headers.authorization);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/x-protobuf" });
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected a bound TCP address"));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}`, authorizations });
    });
  });
}

/** `closeAllConnections` drops the exporter's keep-alive socket so `close` settles promptly. */
function stopRecordingServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function exportOneSpan(provider: TracerProvider): Promise<void> {
  const span = provider.getTracer("exporter-headers.test").startSpan("op");
  span.end();
  await provider.forceFlush();
}

describe("OTLPTraceExporter async headers factory, against a real HTTP server", () => {
  it("awaits the async factory and puts the resolved Authorization header on the wire", async () => {
    const recording = await startRecordingServer();
    const exporter = new OTLPTraceExporter({
      url: `${recording.url}/v1/traces`,
      headers: async () => ({ Authorization: "Bearer test-token-123" })
    });
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })]
    });

    try {
      await exportOneSpan(provider);
      expect(recording.authorizations).toEqual(["Bearer test-token-123"]);
    } finally {
      await provider.shutdown();
      await stopRecordingServer(recording.server);
    }
  });

  it("calls the factory again for a second export rather than reusing the first result", async () => {
    const recording = await startRecordingServer();
    let issued = 0;
    const exporter = new OTLPTraceExporter({
      url: `${recording.url}/v1/traces`,
      headers: async () => {
        issued += 1;
        return { Authorization: `Bearer token-${issued}` };
      }
    });
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })]
    });

    try {
      await exportOneSpan(provider);
      await exportOneSpan(provider);

      expect(recording.authorizations).toEqual(["Bearer token-1", "Bearer token-2"]);
    } finally {
      await provider.shutdown();
      await stopRecordingServer(recording.server);
    }
  });

  it("carries createTokenSource's helper-issued token through a real exporter", async () => {
    const recording = await startRecordingServer();
    const tokenSource = createTokenSource({
      command: ["fake-helper"],
      logger: silentLogger(),
      // No process spawns: this stands in for the credential helper's stdout.
      run: async () => ({ stdout: "helper-issued-token", stderr: "", code: 0 })
    });
    const exporter = new OTLPTraceExporter({
      url: `${recording.url}/v1/traces`,
      headers: () => tokenSource.headers()
    });
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })]
    });

    try {
      await exportOneSpan(provider);
      expect(recording.authorizations).toEqual(["Bearer helper-issued-token"]);
    } finally {
      await provider.shutdown();
      await stopRecordingServer(recording.server);
    }
  });
});

/**
 * The fail-closed gate (ADR-0015) lives in `withFailureLogging`, one level above
 * the exporter these tests use directly above — so these exercise the real
 * production wiring (`withFailureLogging(new OTLPTraceExporter(...), ...)`)
 * against a real HTTP server to prove no request reaches the wire at all when
 * the credential is unavailable, not merely that the header is missing.
 */
describe("withFailureLogging's credential gate, against a real HTTP server", () => {
  it("sends zero requests when the token source cannot produce a credential", async () => {
    const recording = await startRecordingServer();
    const tokenSource = createTokenSource({
      command: ["fake-helper"],
      logger: silentLogger(),
      run: async () => ({ stdout: "", stderr: "no session", code: 1 })
    });
    const exporter = withFailureLogging(
      new OTLPTraceExporter({
        url: `${recording.url}/v1/traces`,
        // Real exporters need `Record<string, string>`; by the time this runs
        // the gate has already confirmed a credential exists, so `?? {}` only
        // ever matters for the type checker, not at runtime.
        headers: async () => (await tokenSource.headers()) ?? {}
      }),
      "traces",
      silentLogger(),
      { tokenSource }
    );
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })]
    });

    try {
      // `SimpleSpanProcessor.forceFlush()` rejects on a non-SUCCESS export
      // result — exactly as it would for a genuine network failure, since our
      // skip reports `ExportResultCode.FAILED` too (see ADR-0015's
      // Consequences). Production code never observes this: `createProviders`'s
      // public `forceFlush()` wraps every signal in `Promise.allSettled` (see
      // `providers.ts`), so this rejection never escapes there. Here we only
      // care about what reached the wire, so swallow it.
      await exportOneSpan(provider).catch(() => {});
      // Give a wrongly-not-skipped request time to land before asserting.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(recording.authorizations).toEqual([]);
    } finally {
      await provider.shutdown();
      await stopRecordingServer(recording.server);
    }
  });

  it("sends exactly one authenticated request once the token source recovers", async () => {
    const recording = await startRecordingServer();
    let fail = true;
    const tokenSource = createTokenSource({
      command: ["fake-helper"],
      logger: silentLogger(),
      run: async () =>
        fail
          ? { stdout: "", stderr: "no session", code: 1 }
          : { stdout: "recovered-token", stderr: "", code: 0 }
    });
    const exporter = withFailureLogging(
      new OTLPTraceExporter({
        url: `${recording.url}/v1/traces`,
        // Real exporters need `Record<string, string>`; by the time this runs
        // the gate has already confirmed a credential exists, so `?? {}` only
        // ever matters for the type checker, not at runtime.
        headers: async () => (await tokenSource.headers()) ?? {}
      }),
      "traces",
      silentLogger(),
      { tokenSource }
    );
    const provider = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })]
    });

    try {
      // See the previous test for why this rejection is expected and harmless.
      await exportOneSpan(provider).catch(() => {});
      expect(recording.authorizations).toEqual([]);

      // The user logs in / the helper starts succeeding — no restart involved.
      fail = false;
      await exportOneSpan(provider);
      expect(recording.authorizations).toEqual(["Bearer recovered-token"]);
    } finally {
      await provider.shutdown();
      await stopRecordingServer(recording.server);
    }
  });
});
