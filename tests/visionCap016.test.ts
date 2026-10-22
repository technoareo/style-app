import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import {
  analyzePhoto,
  ANSWER_CUT_MESSAGE,
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

test("an answer cut at the output bound gets a cause-neutral message (the bound does not prove too many items), and is charged as a model result", async () => {
  handler = (_req, res) => streamed(res, '{"items":[{"name":"Item 1","categ', "length");
  await assert.rejects(analyzePhoto(photo), (error: unknown) => {
    assert.ok(error instanceof VisionError);
    assert.equal(error.kind, "unverified");
    assert.equal(error.message, ANSWER_CUT_MESSAGE);
    assert.ok(!/too many/i.test(error.message), "no cause is asserted");
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

/* ------------------------------------------------------------------ */
/* Build 016 revision 2: strict stream protocol and upstream cleanup    */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const line = (value: unknown) => JSON.stringify(value) + "\n";
const piece = (content: string) => line({ message: { content }, done: false });
const terminal = (reason = "stop") =>
  line({ message: { content: "" }, done: true, done_reason: reason });
const HEADERS = ["application/x-ndjson", "application/json"];

/**
 * Serves `send` and records when the server side of the request closed. A
 * response that is written but never ended stays open until the client
 * disconnects, so `closed` only turns true if analyzePhoto really abandoned the
 * upstream request.
 */
function serve(
  send: (res: ServerResponse) => void | Promise<void>,
  contentType: string | null = "application/x-ndjson",
) {
  const state = { closed: false };
  handler = (_req, res) => {
    res.once("close", () => {
      state.closed = true;
    });
    if (contentType) res.setHeader("content-type", contentType);
    void Promise.resolve(send(res)).catch(() => {});
  };
  return state;
}
async function closedWithin(state: { closed: boolean }, ms = 2000) {
  const end = Date.now() + ms;
  while (!state.closed && Date.now() < end) await sleep(10);
  return state.closed;
}

/**
 * The call must be refused quickly (far below the 10 s smallest deadline) with
 * `kind`, and, when the server leaves the response open, the server must see
 * the request close.
 */
async function refused(
  label: string,
  send: (res: ServerResponse) => void | Promise<void>,
  options: { kind?: VisionError["kind"]; open?: boolean; contentType?: string | null } = {},
) {
  const { kind = "unavailable", open = true, contentType = "application/x-ndjson" } = options;
  const state = serve(send, contentType);
  const started = Date.now();
  try {
    await assert.rejects(analyzePhoto(photo), (error: unknown) => {
      assert.ok(error instanceof VisionError, `a VisionError (${String(error)})`);
      assert.equal(error.kind, kind);
      return true;
    });
    assert.ok(Date.now() - started < 3000, `refused promptly (${Date.now() - started} ms)`);
    if (open) assert.ok(await closedWithin(state), "the upstream request was closed");
  } catch (error) {
    throw new Error(`${label} [${contentType}]: ${(error as Error).message}`);
  }
}

test("a stream without its terminal marker is refused (done:false then EOF, compact one-body without done)", async () => {
  for (const contentType of HEADERS) {
    await refused("ndjson done:false", (res) => void res.end(piece(answer(1))), { open: false, contentType });
    await refused(
      "compact done:false",
      (res) => void res.end(JSON.stringify({ message: { content: answer(1) }, done: false })),
      { open: false, contentType },
    );
    await refused(
      "compact without done",
      (res) => void res.end(JSON.stringify({ message: { content: answer(1) } })),
      { open: false, contentType },
    );
  }
  await refused("pretty without done", (res) => void res.end(JSON.stringify({ message: { content: answer(1) } }, null, 2)), {
    open: false,
    contentType: null,
  });
});

test("an empty body, blank lines only and a terminal with no content are refused or unverified, never accepted", async () => {
  await refused("empty", (res) => void res.end(), { open: false });
  await refused("blank lines", (res) => void res.end("\n\r\n  \n"), { open: false });
  // A valid envelope whose joined content is empty reaches the content check.
  await refused("terminal only", (res) => void res.end(terminal()), { open: false, kind: "unverified" });
});

test("malformed protocol input is refused at the first bad line and the still-open upstream request is closed", async () => {
  const ok = piece(answer(1));
  const cases: [string, string][] = [
    ["error line", line({ error: "boom" })],
    ["malformed leading line", "BROKEN JSON\n" + ok + terminal()],
    ["malformed trailing line after terminal", ok + terminal() + "{not json}\n"],
    ["junk between valid lines", ok + "garbage\n" + piece("x") + terminal()],
    ["second terminal", ok + terminal() + terminal()],
    ["content after the terminal", ok + terminal() + piece("late")],
    ["two objects on one line", ok.trimEnd() + piece("x") + terminal()],
    ["truncated object line", ok + '{"message":{"content":"a"\n' + terminal()],
  ];
  for (const value of ["null", "[]", "5", '"text"', "true"]) {
    cases.push([`non-object ${value} first`, value + "\n" + ok + terminal()]);
    cases.push([`non-object ${value} after content`, ok + value + "\n" + terminal()]);
  }
  for (const [label, body] of cases)
    for (const contentType of HEADERS)
      await refused(label, (res) => void res.write(body), { contentType });
});

test("wrong envelope types are refused: content, done, done_reason, message, error", async () => {
  const bad: unknown[] = [
    { message: { content: 5 }, done: false },
    { message: { content: { a: 1 } }, done: false },
    { message: { content: null }, done: false },
    { message: [], done: false },
    { message: null, done: false },
    { message: "text", done: false },
    { message: { content: "x" }, done: "true" },
    { message: { content: "x" }, done: 1 },
    { message: { content: "x" }, done: null },
    { message: { content: "" }, done: true, done_reason: 5 },
    { message: { content: "" }, done: true, done_reason: null },
    { message: { content: "x" }, done: false, error: "model failed" },
  ];
  for (const value of bad)
    await refused(JSON.stringify(value), (res) => void res.write(line(value) + terminal()));
});

test("one-body compatibility is bounded: leading or trailing garbage is refused, and pretty-printed text is not an open-ended accepted stream", async () => {
  const pretty = JSON.stringify({ message: { content: answer(1) }, done: true }, null, 2);
  await refused("pretty + trailing garbage", (res) => void res.end(pretty + "\ntrailing"), {
    open: false,
    contentType: null,
  });
  await refused("pretty + second object", (res) => void res.end(pretty + "\n" + pretty), {
    open: false,
    contentType: null,
  });
  await refused("object + garbage line", (res) => void res.end(JSON.stringify({ message: { content: "" }, done: true }) + "\nBROKEN"), {
    open: false,
    contentType: null,
  });
  // Arbitrary leading text, server leaves the response open: refused at once.
  for (const contentType of [null, ...HEADERS])
    await refused("leading garbage then open", (res) => void res.write("BROKEN JSON\n" + pretty), { contentType });
  // A declared NDJSON response never takes the one-body path.
  await refused("declared ndjson with pretty body", (res) => void res.end(pretty), {
    open: false,
    contentType: "application/x-ndjson",
  });
});

test("invalid UTF-8 is refused, including a sequence cut off at the end of the stream", async () => {
  const head = Buffer.from('{"message":{"content":"a');
  const tail = Buffer.from('"},"done":true}\n');
  await refused("bad bytes in the middle", (res) => void res.write(Buffer.concat([head, Buffer.from([0xff, 0xfe]), tail])));
  await refused("overlong / lone continuation", (res) => void res.write(Buffer.concat([head, Buffer.from([0xc0, 0x80, 0x80]), tail])));
  await refused(
    "cut multi-byte sequence at EOF",
    (res) => void res.end(Buffer.concat([Buffer.from(piece(answer(1))), Buffer.from(terminal()), Buffer.from([0xe6, 0x97])])),
    { open: false },
  );
});

test("an oversize answer is refused and the open upstream request is closed", async () => {
  // Many valid lines whose content together passes the 2,000,000 character bound.
  await refused("oversize total", (res) => {
    for (let i = 0; i < 25; i++) res.write(piece("x".repeat(100_000)));
  });
  // One line that never ends, longer than any real answer.
  await refused("oversize single line", (res) => void res.write(" ".repeat(10) + '{"message":{"content":"' + "y".repeat(600_000)));
  await refused("oversize pretty body", (res) => void res.write('{\n  "message": {\n    "content": "' + "z".repeat(600_000)), {
    contentType: null,
  });
});

test("a non-200 answer and a transport that dies mid-stream are 'unavailable'; the request is closed", async () => {
  await refused("non-200 with open body", (res) => {
    res.statusCode = 500;
    res.write("partial");
  });
  await refused(
    "destroyed mid-stream",
    async (res) => {
      res.write(piece("{"));
      await sleep(50);
      res.destroy();
    },
    { open: false },
  );
  await refused(
    "truncated transport (content-length not reached)",
    async (res) => {
      res.setHeader("content-length", "5000");
      res.write(piece("{"));
      await sleep(50);
      res.destroy();
    },
    { open: false },
  );
});

test("accepted shapes: CRLF, a final line without a newline, blank lines, surrounding whitespace, a compact body without a trailing newline", async () => {
  const body = answer(2);
  const sends: [string, (res: ServerResponse) => void][] = [
    ["CRLF and no final newline", (res) => void res.end(piece(body).trimEnd() + "\r\n" + terminal().trimEnd())],
    ["blank lines between and after", (res) => void res.end("\n" + piece(body) + "\n\r\n" + terminal() + "\n\n  \n")],
    ["compact, no newline", (res) => void res.end(JSON.stringify({ message: { content: body }, done: true }))],
    ["compact, surrounded", (res) => void res.end("\n\n" + JSON.stringify({ message: { content: body }, done: true }) + "\n\n")],
    ["pretty, surrounded", (res) => void res.end("\n" + JSON.stringify({ message: { content: body }, done: true }, null, 2) + "\n\n")],
  ];
  for (const contentType of HEADERS)
    for (const [label, send] of sends) {
      if (contentType === "application/x-ndjson" && label.startsWith("pretty")) continue;
      serve(send, contentType);
      const result = await analyzePhoto(photo);
      assert.equal(result.analysis.items.length, 2, `${label} [${contentType}]`);
    }
});

test("multi-byte UTF-8 split across chunk boundaries round-trips", async () => {
  const text = JSON.stringify({
    items: [{ ...item(1), name: "Café 日本 👕" }],
    warning: "",
  });
  const bytes = Buffer.from(piece(text) + terminal());
  // Cut before and after every non-ASCII byte, so each sequence is split.
  const cuts = new Set<number>();
  bytes.forEach((byte, i) => {
    if (byte >= 0x80) {
      cuts.add(i);
      cuts.add(i + 1);
    }
  });
  const edges = [0, ...[...cuts].sort((a, b) => a - b).filter((n) => n > 0 && n < bytes.length), bytes.length];
  serve(async (res) => {
    for (let i = 0; i + 1 < edges.length; i++) {
      res.write(bytes.subarray(edges[i], edges[i + 1]));
      await sleep(5);
    }
    res.end();
  });
  assert.ok(edges.length > 8, "the answer really was split into several chunks");
  const result = await analyzePhoto(photo);
  assert.equal(result.analysis.items[0].name, "Café 日本 👕");
});

test("a caller abort mid-stream is 'unavailable' and the upstream request is closed, not left generating", async () => {
  const state = serve((res) => void res.write(piece("{")));
  const controller = new AbortController();
  const aborted = analyzePhoto(photo, controller.signal);
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(aborted, (error: unknown) => {
    assert.ok(error instanceof VisionError);
    assert.equal(error.kind, "unavailable");
    return true;
  });
  assert.ok(await closedWithin(state), "the server saw the request close");
});

test("the inference deadline is a 'timeout' (not overridden by the cleanup) and the upstream request is closed", async () => {
  process.env.STYLE_INFERENCE_TIMEOUT_MS = "10000";
  try {
    const state = serve((res) => void res.write(piece("{")));
    await assert.rejects(analyzePhoto(photo), (error: unknown) => {
      assert.ok(error instanceof VisionError);
      assert.equal(error.kind, "timeout");
      assert.equal(error.message, TOO_SLOW_MESSAGE);
      return true;
    });
    assert.ok(await closedWithin(state), "the server saw the request close");
  } finally {
    delete process.env.STYLE_INFERENCE_TIMEOUT_MS;
  }
});

test("a protocol failure keeps its own kind and message: the cleanup's own abort is not read as a deadline or a caller abort", async () => {
  const state = serve((res) => void res.write(line({ error: "boom" })));
  await assert.rejects(analyzePhoto(photo), (error: unknown) => {
    assert.ok(error instanceof VisionError);
    assert.equal(error.kind, "unavailable");
    assert.notEqual(error.message, TOO_SLOW_MESSAGE);
    return true;
  });
  assert.ok(await closedWithin(state));
});
