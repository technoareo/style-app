import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import {
  analyzePhoto,
  TOO_MANY_ITEMS_MESSAGE,
  TOO_SLOW_MESSAGE,
  VisionError,
} from "../src/server/vision";
import {
  CROWDED_WARNING,
  MAX_DETECTED_ITEMS,
  visionOutputSchema,
} from "../src/domain/analysis";

/**
 * Build 016: the per-photo item limit, the streamed answer and the single
 * inference deadline, against a mock Ollama on a private port (no model).
 */

let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => handler(req, res, body));
});
let photo: Buffer;
const previousUrl = process.env.OLLAMA_URL;
const previousTimeout = process.env.STYLE_INFERENCE_TIMEOUT_MS;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.OLLAMA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  photo = await sharp({
    create: { width: 64, height: 64, channels: 3, background: "#888888" },
  })
    .jpeg()
    .toBuffer();
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (previousUrl === undefined) delete process.env.OLLAMA_URL;
  else process.env.OLLAMA_URL = previousUrl;
  if (previousTimeout === undefined) delete process.env.STYLE_INFERENCE_TIMEOUT_MS;
  else process.env.STYLE_INFERENCE_TIMEOUT_MS = previousTimeout;
});

const item = (n: number) => ({
  name: `Item ${n}`,
  category: "Tops",
  color: "white",
  pattern: "solid",
  formality: "casual",
  brand: "",
  size: "",
  confidence: 0.75,
  evidence: "visible",
  box: [100, 100, 500, 500],
});
const answer = (count: number, warning = "") =>
  JSON.stringify({
    items: Array.from({ length: count }, (_, i) => item(i + 1)),
    warning,
  });

/** Streamed Ollama answer: the text in pieces, one JSON object per line. */
function streamed(res: ServerResponse, text: string, doneReason = "stop") {
  res.setHeader("content-type", "application/x-ndjson");
  const size = Math.ceil(text.length / 3);
  for (let i = 0; i < text.length; i += size)
    res.write(
      JSON.stringify({ message: { content: text.slice(i, i + size) }, done: false }) +
        "\n",
    );
  res.end(
    JSON.stringify({ message: { content: "" }, done: true, done_reason: doneReason }) +
      "\n",
  );
}

test("the request is streamed and carries the item limit and a bounded output", async () => {
  let seen: Record<string, unknown> = {};
  handler = (_req, res, body) => {
    seen = JSON.parse(body);
    streamed(res, answer(1));
  };
  const result = await analyzePhoto(photo);
  assert.equal(seen.stream, true);
  const format = seen.format as typeof visionOutputSchema;
  assert.equal(format.properties.items.maxItems, MAX_DETECTED_ITEMS);
  const options = seen.options as { num_predict: number };
  assert.ok(options.num_predict <= 1100 && options.num_predict >= 600);
  assert.equal(result.analysis.items.length, 1);
  assert.equal(result.analysis.warning, "");
});

test("a streamed answer split across lines and a one-body answer (compact or pretty) all read the same", async () => {
  for (const send of [
    (res: ServerResponse) => streamed(res, answer(2)),
    (res: ServerResponse) =>
      res.end(JSON.stringify({ message: { content: answer(2) }, done: true })),
    (res: ServerResponse) =>
      res.end(JSON.stringify({ message: { content: answer(2) }, done: true }, null, 2)),
  ]) {
    handler = (_req, res) => send(res);
    const result = await analyzePhoto(photo);
    assert.equal(result.analysis.items.length, 2);
  }
});

test("a photo that fills the limit is flagged as crowded; one item below the limit is not", async () => {
  handler = (_req, res) => streamed(res, answer(MAX_DETECTED_ITEMS - 1, "Only visible."));
  const below = await analyzePhoto(photo);
  assert.equal(below.analysis.items.length, MAX_DETECTED_ITEMS - 1);
  assert.ok(!below.analysis.warning.includes(CROWDED_WARNING));

  handler = (_req, res) => streamed(res, answer(MAX_DETECTED_ITEMS, "Only visible."));
  const full = await analyzePhoto(photo);
  assert.equal(full.analysis.items.length, MAX_DETECTED_ITEMS);
  assert.ok(full.analysis.warning.startsWith("Only visible."));
  assert.ok(full.analysis.warning.endsWith(CROWDED_WARNING));
});

test("a model that ignores the limit is cut to it and flagged: nothing past the limit is listed", async () => {
  handler = (_req, res) => streamed(res, answer(MAX_DETECTED_ITEMS + 4));
  const result = await analyzePhoto(photo);
  assert.equal(result.analysis.items.length, MAX_DETECTED_ITEMS);
  assert.deepEqual(
    result.analysis.items.map((i) => i.name),
    Array.from({ length: MAX_DETECTED_ITEMS }, (_, i) => `Item ${i + 1}`),
  );
  assert.ok(result.analysis.warning.includes(CROWDED_WARNING));
});

test("an answer cut at the output bound says the photo has too many items, and is charged as a model result", async () => {
  handler = (_req, res) => streamed(res, '{"items":[{"name":"Item 1","categ', "length");
  await assert.rejects(analyzePhoto(photo), (error: unknown) => {
    assert.ok(error instanceof VisionError);
    assert.equal(error.kind, "unverified");
    assert.equal(error.message, TOO_MANY_ITEMS_MESSAGE);
    return true;
  });
});

test("a malformed item list still fails verification, as before", async () => {
  handler = (_req, res) =>
    streamed(res, JSON.stringify({ items: "none", warning: "" }));
  await assert.rejects(analyzePhoto(photo), (error: unknown) => {
    assert.ok(error instanceof VisionError);
    assert.equal(error.kind, "unverified");
    return true;
  });
});

test("a server error line and a non-200 answer are 'unavailable', not a timeout", async () => {
  handler = (_req, res) => {
    res.setHeader("content-type", "application/x-ndjson");
    res.end(JSON.stringify({ error: "boom" }) + "\n");
  };
  await assert.rejects(analyzePhoto(photo), (error: unknown) => {
    assert.ok(error instanceof VisionError);
    assert.equal(error.kind, "unavailable");
    return true;
  });
  handler = (_req, res) => {
    res.statusCode = 400;
    res.end("{}");
  };
  await assert.rejects(analyzePhoto(photo), (error: unknown) => {
    assert.ok(error instanceof VisionError);
    assert.equal(error.kind, "unavailable");
    return true;
  });
});

test("a caller abort is 'unavailable'; the inference deadline, reached while the model is still writing, is a timeout with its own message", async () => {
  // Starts the answer (headers and a first piece arrive) and then stalls.
  handler = (_req, res) => {
    res.setHeader("content-type", "application/x-ndjson");
    res.write(JSON.stringify({ message: { content: "{" }, done: false }) + "\n");
  };
  const controller = new AbortController();
  const aborted = analyzePhoto(photo, controller.signal);
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(aborted, (error: unknown) => {
    assert.ok(error instanceof VisionError);
    assert.equal(error.kind, "unavailable");
    return true;
  });

  process.env.STYLE_INFERENCE_TIMEOUT_MS = "10000"; // the smallest the limit allows
  const started = Date.now();
  await assert.rejects(analyzePhoto(photo), (error: unknown) => {
    assert.ok(error instanceof VisionError);
    assert.equal(error.kind, "timeout");
    assert.equal(error.message, TOO_SLOW_MESSAGE);
    return true;
  });
  const waited = Date.now() - started;
  assert.ok(waited >= 9_500 && waited < 15_000, `deadline took ${waited} ms`);
  delete process.env.STYLE_INFERENCE_TIMEOUT_MS;
});
