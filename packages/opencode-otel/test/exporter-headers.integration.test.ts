import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";

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
