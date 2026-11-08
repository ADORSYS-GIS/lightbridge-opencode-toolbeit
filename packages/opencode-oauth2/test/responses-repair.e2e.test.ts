import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NONCONFORMANT_RESPONSES_SSE } from "./fixtures/responses-sse.js";
import { type Harness, OAUTH_BLOCK, startPlugin } from "./harness.js";

// End-to-end against a local stub that serves the captured non-conformant Envoy
// AI Gateway `/v1/responses` SSE. Two layers:
//   1. wire conformance — the defect is present in the raw stream and the repair
//      injects the indices a strict consumer needs (the necessity guard);
//   2. real consumer  — the actual `@ai-sdk/openai` Responses model assembles
//      the correct answer from the repaired stream.
//
// Note: bare `@ai-sdk/openai` tolerates the missing indices, so there is no
// SDK-level negative control — the strict consumer that fails without the repair
// is OpenCode's part layer (verified manually). The wire-conformance assertions
// below are what guarantee the repair keeps producing what that layer requires.

let server: Server;
let baseURL: string;
let harness: Harness;

/**
 * A `fetch` that behaves like the v2 host around the plugin: it performs the
 * HTTP exchange, then offers it to the plugin's REAL `session.hook("http.response")`
 * and returns whatever response the hook leaves on the event. This is the seam
 * that replaced v1's `provider.options.fetch` wrapper.
 */
function hostFetch(providerID: string): typeof fetch {
  return (async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const event = {
      model: { id: "test-model", providerID },
      request,
      response: await fetch(request)
    };
    await harness.call("http.response", event);
    return event.response;
  }) as typeof fetch;
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(NONCONFORMANT_RESPONSES_SSE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseURL = `http://127.0.0.1:${port}/v1`;

  harness = await startPlugin({
    sources: [
      {
        id: "gw",
        settings: { baseURL, oauth2: { ...OAUTH_BLOCK, responseApi: true } }
      },
      { id: "plain", settings: { baseURL } }
    ]
  });
  harness.runTransform();
});

afterAll(async () => {
  await harness.close();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

type Event = Record<string, unknown>;

function parseEvents(sse: string): Event[] {
  return sse
    .split("\n\n")
    .map((b) => b.match(/data:\s*(\{[\s\S]*\})/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => JSON.parse(m[1]) as Event);
}

const needsOutputIndex = (e: Event) =>
  typeof e.type === "string" &&
  /^response\.(output_item|content_part|output_text|reasoning_text)\./.test(e.type);

const needsContentIndex = (e: Event) =>
  typeof e.type === "string" && /content_part|output_text|reasoning_text/.test(e.type);

describe("responses repair — wire conformance over HTTP", () => {
  it("the raw gateway stream is missing output_index / content_index", async () => {
    // Fetch straight from the stub (no repair) to document the defect.
    const raw = await (await fetch(`${baseURL}/responses`, { method: "POST" })).text();
    const events = parseEvents(raw);

    expect(events.some((e) => e.type === "response.output_item.added")).toBe(true);
    expect(events.filter(needsOutputIndex).every((e) => e.output_index === undefined)).toBe(true);
    expect(events.filter(needsContentIndex).every((e) => e.content_index === undefined)).toBe(true);
  });

  it("the repair fetch injects the indices a strict consumer needs", async () => {
    const repaired = await (
      await hostFetch("gw")(`${baseURL}/responses`, { method: "POST" })
    ).text();
    const events = parseEvents(repaired);

    // every item/content/text event now carries an output_index...
    expect(events.filter(needsOutputIndex).every((e) => typeof e.output_index === "number")).toBe(
      true
    );
    // ...the two items are numbered in arrival order...
    expect(
      events.filter((e) => e.type === "response.output_item.added").map((e) => e.output_index)
    ).toEqual([0, 1]);
    // ...and content/text/reasoning events carry a content_index.
    expect(events.filter(needsContentIndex).every((e) => e.content_index === 0)).toBe(true);
  });

  it("only touches /responses event-streams, not other routes", async () => {
    // a non-/responses URL is returned verbatim even if it streams
    const passthrough = await hostFetch("gw")(`${baseURL}/models`, { method: "GET" });
    expect(await passthrough.text()).toBe(NONCONFORMANT_RESPONSES_SSE);
  });

  it("only repairs providers that opted into responseApi", async () => {
    // Same defective /responses stream, but the provider did not opt in: untouched.
    const untouched = await hostFetch("plain")(`${baseURL}/responses`, { method: "POST" });
    expect(await untouched.text()).toBe(NONCONFORMANT_RESPONSES_SSE);
  });
});

describe("responses repair — real @ai-sdk/openai consumer", () => {
  it("assembles the correct answer from the repaired stream", async () => {
    const openai = createOpenAI({
      baseURL,
      apiKey: "test-key",
      fetch: hostFetch("gw")
    });

    const result = streamText({ model: openai.responses("test-model"), prompt: "hi" });

    let streamed = "";
    for await (const delta of result.textStream) {
      streamed += delta;
    }

    expect(streamed).toBe("ok");
    expect(await result.text).toBe("ok");
    expect((await result.usage).totalTokens).toBe(2);
  });
});
