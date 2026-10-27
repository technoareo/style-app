import test, { after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import {
  analyzePhoto,
  configuredVisionModel,
  DEFAULT_VISION_MODEL,
  isModelAvailable,
  VisionError,
} from "../src/server/vision";
import {
  analysisSchema,
  reviewAnalysisSchema,
  cleanModelWarning,
  composeWarning,
  CROP_UNVERIFIED_WARNING,
  CROWDED_WARNING,
  MAX_DETECTED_ITEMS,
  mostProminentIndex,
  usableBox,
  MAX_SINGLE_CANDIDATES,
  MULTIPLE_ITEMS_WARNING,
  SHOE_PAIR_WARNING,
  refineSingleItem,
  singleVisionOutputSchema,
  SINGLE_ITEM_PROMPT,
  VISIBLE_MATERIALS,
} from "../src/domain/analysis";
import { backupSchema } from "../src/domain/backup";

/**
 * Build 018: the single-item photo path and the VISION_MODEL setting, against a
 * mock Ollama on a private port. No model is installed or called: these tests
 * show how answers are validated, never whether a real model reads real photos.
 */

let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;
let requests = 0;
const server = createServer((req, res) => {
  requests += 1;
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => handler(req, res, body));
});
let photo: Buffer;
const saved = {
  url: process.env.OLLAMA_URL,
  model: process.env.VISION_MODEL,
};

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.OLLAMA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  photo = await sharp({
    create: { width: 64, height: 64, channels: 3, background: "#888888" },
  })
    .jpeg()
    .toBuffer();
});
afterEach(() => {
  requests = 0;
  if (saved.model === undefined) delete process.env.VISION_MODEL;
  else process.env.VISION_MODEL = saved.model;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (saved.url === undefined) delete process.env.OLLAMA_URL;
  else process.env.OLLAMA_URL = saved.url;
});

const goodItem = (over: Record<string, unknown> = {}) => ({
  name: "Blue denim jacket",
  category: "Outerwear",
  color: "blue",
  pattern: "solid",
  material: "denim",
  fit: "relaxed",
  seasons: ["spring", "autumn"],
  occasions: ["everyday"],
  formality: "casual",
  brand: "",
  size: "",
  confidence: 0.75,
  uncertain: [],
  evidence: "Visible stitching and metal buttons",
  box: [100, 100, 900, 900],
  ...over,
});
const reply = (items: unknown[], warning = "") => JSON.stringify({ items, warning });

function streamed(res: ServerResponse, text: string) {
  res.setHeader("content-type", "application/x-ndjson");
  res.write(JSON.stringify({ message: { content: text }, done: false }) + "\n");
  res.end(JSON.stringify({ message: { content: "" }, done: true, done_reason: "stop" }) + "\n");
}

// ---- VISION_MODEL: one validated setting, used everywhere ----

test("VISION_MODEL: unset or blank gives the documented default; valid references are trimmed and kept", () => {
  assert.deepEqual(configuredVisionModel({}), { ok: true, name: DEFAULT_VISION_MODEL });
  assert.deepEqual(configuredVisionModel({ VISION_MODEL: "" }), { ok: true, name: DEFAULT_VISION_MODEL });
  assert.deepEqual(configuredVisionModel({ VISION_MODEL: "   " }), { ok: true, name: DEFAULT_VISION_MODEL });
  for (const name of [
    "qwen3-vl:4b-instruct",
    "qwen3-vl:2b-instruct",
    "llava",
    "llava:7b",
    "library/llava:7b-v1.6",
    "hf.co/user/model_name:Q4_K_M",
    "gemma3:4b",
  ])
    assert.deepEqual(configuredVisionModel({ VISION_MODEL: ` ${name}\n` }), { ok: true, name });
});

test("VISION_MODEL: a malformed value is refused, never replaced by the default", () => {
  for (const bad of [
    "qwen3 vl",
    "a;b",
    "model:",
    ":tag",
    "-lead",
    "a//b",
    "/a",
    "a/",
    "http://x/y",
    "m\u0000odel",
    "mod'el",
    'mod"el',
    "../model",
    "model:tag:tag",
    "x".repeat(101),
    "étude",
    "model\nother",
  ])
    assert.deepEqual(configuredVisionModel({ VISION_MODEL: bad }), { ok: false }, JSON.stringify(bad));
});

test("the configured model is the one sent to Ollama, and the default when unset", async () => {
  const seen: string[] = [];
  handler = (_req, res, body) => {
    seen.push(JSON.parse(body).model);
    streamed(res, reply([goodItem()]));
  };
  delete process.env.VISION_MODEL;
  await analyzePhoto(photo);
  process.env.VISION_MODEL = "llava:7b";
  await analyzePhoto(photo);
  assert.deepEqual(seen, [DEFAULT_VISION_MODEL, "llava:7b"]);
});

test("readiness checks the same configured model (and accepts an untagged pull as :latest)", async () => {
  const listing = (...names: string[]) => (_req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ models: names.map((name) => ({ name })) }));
  };
  handler = listing("qwen3-vl:4b-instruct");
  delete process.env.VISION_MODEL;
  assert.equal(await isModelAvailable(), true);
  process.env.VISION_MODEL = "llava:7b";
  assert.equal(await isModelAvailable(), false, "the default is installed, the configured model is not");
  handler = listing("qwen3-vl:4b-instruct", "llava:7b");
  assert.equal(await isModelAvailable(), true);
  process.env.VISION_MODEL = "llava";
  handler = listing("llava:latest");
  assert.equal(await isModelAvailable(), true);
  handler = listing("llava:7b");
  assert.equal(await isModelAvailable(), false, "an untagged name means :latest, not any tag");
});

test("a malformed VISION_MODEL makes analysis unavailable (refundable) without calling Ollama, and readiness false", async () => {
  handler = (_req, res) => streamed(res, reply([goodItem()]));
  process.env.VISION_MODEL = "bad model name";
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.join(" "));
  try {
    await assert.rejects(analyzePhoto(photo), (error: unknown) => {
      assert.ok(error instanceof VisionError);
      assert.equal(error.kind, "unavailable");
      return true;
    });
    assert.equal(await isModelAvailable(), false);
  } finally {
    console.error = original;
  }
  assert.equal(requests, 0, "nothing was sent to Ollama");
  assert.ok(logged.every((line) => !line.includes("bad model name")), "the value is not echoed");
});

// ---- the single-item request ----

test("the request allows a short candidate list (so more than one item can be DETECTED), bounds the output and cannot name a fiber as a material", async () => {
  let seen: Record<string, unknown> = {};
  handler = (_req, res, body) => {
    seen = JSON.parse(body);
    streamed(res, reply([goodItem()]));
  };
  await analyzePhoto(photo);
  const format = seen.format as typeof singleVisionOutputSchema;
  assert.equal(format.properties.items.maxItems, MAX_SINGLE_CANDIDATES);
  assert.ok(MAX_SINGLE_CANDIDATES > 1, "a schema of one item could never report a second one");
  const itemSchema = format.properties.items.items;
  assert.deepEqual(itemSchema.properties.material.enum, ["", ...VISIBLE_MATERIALS]);
  for (const fiber of ["cotton", "wool", "silk", "polyester", "linen", "cashmere"])
    assert.ok(!itemSchema.properties.material.enum.includes(fiber), fiber);
  for (const key of ["material", "fit", "seasons", "occasions", "uncertain", "confidence", "evidence", "box"])
    assert.ok(itemSchema.required.includes(key), `${key} is required`);
  const message = (seen.messages as Array<{ content: string }>)[0].content;
  assert.ok(message.startsWith(SINGLE_ITEM_PROMPT));
  assert.match(SINGLE_ITEM_PROMPT, /never guess it/);
  const options = seen.options as { num_predict: number };
  assert.ok(options.num_predict >= 600 && options.num_predict <= 1000);
});

test("one clean answer is returned with its attributes, confidence and no invented brand or size", async () => {
  handler = (_req, res) => streamed(res, reply([goodItem({ brand: "Levi's", size: "M" })]));
  const { analysis } = await analyzePhoto(photo);
  assert.equal(analysis.items.length, 1);
  const item = analysis.items[0];
  assert.equal(item.material, "denim");
  assert.equal(item.fit, "relaxed");
  assert.deepEqual(item.seasons, ["spring", "autumn"]);
  assert.deepEqual(item.occasions, ["everyday"]);
  assert.equal(item.confidence, 0.75);
  assert.equal(item.brand, "");
  assert.equal(item.size, "");
  assert.deepEqual(item.box, [0.1, 0.1, 0.8, 0.8]);
  assert.equal(analysis.warning, "");
});

test("a fiber named as the material is dropped and flagged, not kept as a guess", async () => {
  handler = (_req, res) => streamed(res, reply([goodItem({ material: "Cotton" })]));
  const { analysis } = await analyzePhoto(photo);
  assert.equal(analysis.items[0].material, "");
  assert.ok(analysis.items[0].uncertain?.includes("material"));
});

test("out-of-vocabulary fit, seasons and occasions are cut to the allowed lists", async () => {
  handler = (_req, res) =>
    streamed(
      res,
      reply([
        goodItem({
          fit: "skin tight",
          seasons: ["Summer", "monsoon", "summer", 7, "winter"],
          occasions: ["work", "gala", "work", "evening", "active", "lounge"],
          uncertain: ["color", "taste", "color"],
        }),
      ]),
    );
  const { analysis } = await analyzePhoto(photo);
  const item = analysis.items[0];
  assert.equal(item.fit, "unknown");
  assert.deepEqual(item.seasons, ["summer", "winter"]);
  assert.deepEqual(item.occasions, ["work", "evening", "active"]);
  assert.deepEqual(item.uncertain, ["color"]);
});

test("a poor-guess confidence or an unsorted category flags the category for checking", async () => {
  handler = (_req, res) => streamed(res, reply([goodItem({ confidence: 0.25 })]));
  assert.ok((await analyzePhoto(photo)).analysis.items[0].uncertain?.includes("category"));
  handler = (_req, res) => streamed(res, reply([goodItem({ category: "Unsorted", confidence: 0.5 })]));
  assert.ok((await analyzePhoto(photo)).analysis.items[0].uncertain?.includes("category"));
  handler = (_req, res) => streamed(res, reply([goodItem({ confidence: 1 })]));
  assert.deepEqual((await analyzePhoto(photo)).analysis.items[0].uncertain, []);
});

test("a self-reported score of 1 cannot sit beside stated doubts: it is capped, and a score with no doubts is left alone", async () => {
  // Observed with a small real model: confidence 1 while unsure of four attributes.
  handler = (_req, res) =>
    streamed(res, reply([goodItem({ confidence: 1, uncertain: ["color", "pattern", "material", "fit"] })]));
  const doubtful = (await analyzePhoto(photo)).analysis.items[0];
  assert.equal(doubtful.confidence, 0.5);
  assert.deepEqual(doubtful.uncertain, ["color", "pattern", "material", "fit"]);
  // A fibre claim is itself a doubt (flagged), so it caps the score too.
  handler = (_req, res) => streamed(res, reply([goodItem({ confidence: 0.75, material: "wool" })]));
  assert.equal((await analyzePhoto(photo)).analysis.items[0].confidence, 0.5);
  // A low score is never raised, and a score with no doubts is kept as reported.
  handler = (_req, res) => streamed(res, reply([goodItem({ confidence: 0.25, uncertain: ["fit"] })]));
  assert.equal((await analyzePhoto(photo)).analysis.items[0].confidence, 0.25);
  handler = (_req, res) => streamed(res, reply([goodItem({ confidence: 1 })]));
  assert.equal((await analyzePhoto(photo)).analysis.items[0].confidence, 1);
});

test("several items from the model: only the most prominent is kept and the user is told", async () => {
  handler = (_req, res) =>
    streamed(
      res,
      reply([
        goodItem({ name: "Small sock", category: "Accessories", box: [0, 0, 200, 200] }),
        goodItem({ name: "Big coat", category: "Outerwear", box: [50, 50, 950, 950] }),
        goodItem({ name: "Mid scarf", category: "Accessories", box: [0, 0, 500, 400] }),
      ]),
    );
  const { analysis } = await analyzePhoto(photo);
  assert.deepEqual(analysis.items.map((i) => i.name), ["Big coat"]);
  assert.ok(analysis.warning.includes(MULTIPLE_ITEMS_WARNING));
});

const shoe = (name: string, box: number[], over: Record<string, unknown> = {}) =>
  goodItem({ name, category: "Shoes", color: "white", pattern: "solid", box, ...over });
const analyzeWith = async (items: unknown[]) => {
  handler = (_req, res) => streamed(res, reply(items));
  return (await analyzePhoto(photo)).analysis;
};

test("two shoes become ONE pair only on robust evidence, and the user is told to check the crop", async () => {
  const pair = await analyzeWith([
    shoe("Left white sneaker", [100, 400, 450, 800]),
    shoe("Right white sneaker", [500, 420, 900, 820]),
  ]);
  assert.equal(pair.items.length, 1);
  assert.equal(pair.items[0].name, "white sneaker");
  assert.deepEqual(pair.items[0].box, [0.1, 0.4, 0.8, 0.42]);
  assert.ok(pair.warning.includes(SHOE_PAIR_WARNING));
  assert.ok(!pair.warning.includes(MULTIPLE_ITEMS_WARNING));
});

test("shoes without that evidence are NOT merged: a sneaker and a boot, two different pairs, far apart, unequal size, same side, or no sides", async () => {
  const cases: Array<[string, unknown[]]> = [
    ["sneaker + boot", [shoe("Left white sneaker", [100, 400, 450, 800]), shoe("Right brown boot", [500, 420, 900, 820], { color: "brown" })]],
    ["sneaker + boot, same colour", [shoe("Left sneaker", [100, 400, 450, 800]), shoe("Right boot", [500, 420, 900, 820])]],
    ["different colour", [shoe("Left sneaker", [100, 400, 450, 800]), shoe("Right sneaker", [500, 420, 900, 820], { color: "black" })]],
    ["far apart", [shoe("Left sneaker", [0, 0, 200, 200]), shoe("Right sneaker", [700, 700, 900, 900])]],
    ["unequal size", [shoe("Left sneaker", [100, 400, 700, 800]), shoe("Right sneaker", [720, 420, 780, 460])]],
    ["two lefts", [shoe("Left sneaker", [100, 400, 450, 800]), shoe("Left sneaker", [500, 420, 900, 820])]],
    ["no sides", [shoe("Sneaker", [100, 400, 450, 800]), shoe("Sneaker", [500, 420, 900, 820])]],
    ["three shoes", [shoe("Left sneaker", [100, 400, 300, 800]), shoe("Right sneaker", [320, 420, 500, 820]), shoe("Left sneaker", [520, 420, 700, 820])]],
  ];
  for (const [label, items] of cases) {
    const result = await analyzeWith(items);
    assert.equal(result.items.length, 1, label);
    assert.ok(result.warning.includes(MULTIPLE_ITEMS_WARNING), `${label}: warned that several items are visible`);
    assert.ok(!result.warning.includes(SHOE_PAIR_WARNING), `${label}: not presented as a pair`);
    // The single presented item keeps its own box (no union with the other shoe).
    const widest = Math.max(...(items as Array<{ box: number[] }>).map((i) => (i.box[2] - i.box[0]) * (i.box[3] - i.box[1])));
    const kept = result.items[0].box;
    assert.ok(Math.abs(kept[2] * kept[3] * 1_000_000 - widest) < 1, `${label}: the most prominent shoe's own crop`);
  }
});

test("a shoe plus another garment is cut to the most prominent item with the several-items warning", async () => {
  const mixed = await analyzeWith([
    shoe("Sneaker", [0, 600, 200, 800]),
    goodItem({ name: "Coat", category: "Outerwear", box: [50, 50, 950, 950] }),
  ]);
  assert.deepEqual(mixed.items.map((i) => i.name), ["Coat"]);
  assert.ok(mixed.warning.includes(MULTIPLE_ITEMS_WARNING));
});

test("selection rule: the LARGEST valid box wins whatever the model listed first; unusable boxes count as zero; equal areas go to the first listed", async () => {
  // Counterexample to "trust the first entry": the model lists a small sock first.
  handler = (_req, res) =>
    streamed(res, reply([
      goodItem({ name: "Sock", box: [0, 0, 200, 200] }),
      goodItem({ name: "Jacket", box: [100, 100, 900, 900] }),
    ]));
  assert.deepEqual((await analyzePhoto(photo)).analysis.items.map((i) => i.name), ["Jacket"]);
  // A first entry with an unusable box loses to a valid small one.
  handler = (_req, res) =>
    streamed(res, reply([
      goodItem({ name: "Broken box", box: [900, 900, 100, 100] }),
      goodItem({ name: "Small valid", box: [0, 0, 100, 100] }),
    ]));
  assert.deepEqual((await analyzePhoto(photo)).analysis.items.map((i) => i.name), ["Small valid"]);
  // Equal areas: the first listed.
  handler = (_req, res) =>
    streamed(res, reply([
      goodItem({ name: "First", box: [0, 0, 400, 400] }),
      goodItem({ name: "Second", box: [500, 500, 900, 900] }),
    ]));
  assert.deepEqual((await analyzePhoto(photo)).analysis.items.map((i) => i.name), ["First"]);
  assert.equal(mostProminentIndex([{ box: [0, 0, 100, 100] }, { box: [0, 0, 200, 200] }, { box: [0, 0, 200, 200] }]), 1);
  assert.equal(mostProminentIndex([{}, null, { box: "x" }]), 0);
  // The prompt asks for the same thing the server enforces, and does not promise the first entry is chosen.
  assert.match(SINGLE_ITEM_PROMPT, /fills the most of the picture FIRST/);
  assert.doesNotMatch(SINGLE_ITEM_PROMPT, /most prominent item FIRST/);
});

test("only demonstrably non-actionable warning boilerplate is removed; real findings are kept verbatim", async () => {
  for (const empty of ["", "none", "None.", "N/A", "n/a", "null", "No warnings", "  ", "OK"])
    assert.equal(cleanModelWarning(empty), "", JSON.stringify(empty));
  assert.equal(cleanModelWarning(undefined), "");
  // The observed echo, and a sentence copied from our own instructions.
  assert.equal(cleanModelWarning("Only count physical garments. Ignore prints, drawings, text, or people."), "");
  assert.equal(cleanModelWarning("Printed graphics are a pattern of the garment, not separate items."), "");
  // Only the echo sentence goes; the real finding stays, as written.
  assert.equal(
    cleanModelWarning("Printed graphics are a pattern of the garment, not separate items. The photo is blurry on the left."),
    "The photo is blurry on the left.",
  );
  for (const real of ["The photo is blurry.", "The sleeve is partly cut off.", "Only visible from the front.", "Printed graphics cover the chest.", "Item is on a mannequin."])
    assert.equal(cleanModelWarning(real), real);
  // End to end: the warning the user sees.
  handler = (_req, res) => streamed(res, reply([goodItem()], "Printed graphics are a pattern of the garment, not separate items."));
  assert.equal((await analyzePhoto(photo)).analysis.warning, "");
  handler = (_req, res) => streamed(res, reply([goodItem()], "none"));
  assert.equal((await analyzePhoto(photo)).analysis.warning, "");
  handler = (_req, res) => streamed(res, reply([goodItem()], "The photo is blurry."));
  assert.equal((await analyzePhoto(photo)).analysis.warning, "The photo is blurry.");
});

test("one box rule: usableBox clamps slight overshoot, rejects anything else, and the same rule picks the item, tests a pair and makes the crop", async () => {
  assert.deepEqual(usableBox([-10, 0, 1010, 900]), [0, 0, 1000, 900]);
  assert.deepEqual(usableBox([0, 0, 1020, 1000]), [0, 0, 1000, 1000]);
  for (const bad of [[-21, 0, 500, 500], [0, 0, 1021, 500], [0, 0, 20, 500], [0, 0, 500, 29], [500, 0, 100, 500], [0, 0, 500], [0, 0, 500, 500, 1], "box", null, [0, 0, NaN, 500], [0, 0, "500", 500]])
    assert.equal(usableBox(bad), null, JSON.stringify(bad));
  // Selection: a jacket that overshoots slightly beats a small sock, and its crop is its own (clamped), not a full frame.
  handler = (_req, res) =>
    streamed(res, reply([
      goodItem({ name: "Sock", box: [0, 0, 60, 60] }),
      goodItem({ name: "Jacket", box: [-10, 0, 1010, 900] }),
    ]));
  const picked = (await analyzePhoto(photo)).analysis;
  assert.deepEqual(picked.items.map((i) => i.name), ["Jacket"]);
  assert.deepEqual(picked.items[0].box, [0, 0, 1, 0.9]);
  assert.doesNotMatch(picked.warning, /bounds could not be verified/);
  // The reported defect: an item with an unusable box must not be chosen on a
  // positive-but-unusable area and then shown as a full frame while another
  // candidate had a good box.
  handler = (_req, res) =>
    streamed(res, reply([
      goodItem({ name: "Far jacket", box: [-300, 0, 1500, 900] }),
      goodItem({ name: "Thin sock", box: [0, 0, 20, 900] }),
      goodItem({ name: "Usable shirt", box: [100, 100, 400, 400] }),
    ]));
  const guarded = (await analyzePhoto(photo)).analysis;
  assert.deepEqual(guarded.items.map((i) => i.name), ["Usable shirt"]);
  assert.deepEqual(guarded.items[0].box, [0.1, 0.1, 0.3, 0.3]);
  assert.ok(guarded.warning.includes(MULTIPLE_ITEMS_WARNING));
  // Every candidate unusable: the first listed, a full frame, and an honest notice.
  handler = (_req, res) =>
    streamed(res, reply([
      goodItem({ name: "Far jacket", box: [-300, 0, 1500, 900] }),
      goodItem({ name: "Thin sock", box: [0, 0, 20, 900] }),
    ]));
  const none = (await analyzePhoto(photo)).analysis;
  assert.deepEqual(none.items.map((i) => i.name), ["Far jacket"]);
  assert.deepEqual(none.items[0].box, [0, 0, 1, 1]);
  assert.match(none.warning, /bounds could not be verified/);
  // Invariant over many shapes: if any candidate has a usable box, the chosen one does.
  const shapes = [[-300, 0, 1500, 900], [0, 0, 20, 900], [900, 900, 100, 100], [0, 0, 60, 60], [-10, -10, 400, 400], [0, 0, 1000, 1000], [5, 5, 30, 30]];
  for (let i = 0; i < shapes.length; i++)
    for (let j = 0; j < shapes.length; j++) {
      const list = [{ box: shapes[i] }, { box: shapes[j] }];
      const chosen = list[mostProminentIndex(list)];
      if (list.some((c) => usableBox(c.box))) assert.ok(usableBox(chosen.box), `${i},${j}`);
    }
});

test("the shoe-pair test uses the same validity: a slight overshoot still pairs, a thin or out-of-range shoe box does not", async () => {
  const pairOf = (second: number[]) => [
    goodItem({ name: "Left sneaker", category: "Shoes", color: "white", box: [100, 400, 450, 800] }),
    goodItem({ name: "Right sneaker", category: "Shoes", color: "white", box: second }),
  ];
  handler = (_req, res) => streamed(res, reply(pairOf([500, 420, 1010, 820])));
  const ok = (await analyzePhoto(photo)).analysis;
  assert.ok(ok.warning.includes(SHOE_PAIR_WARNING));
  assert.deepEqual(ok.items[0].box, [0.1, 0.4, 0.9, 0.42]);
  for (const thin of [[500, 420, 520, 820], [500, 420, 1100, 820]]) {
    handler = (_req, res) => streamed(res, reply(pairOf(thin)));
    const no = (await analyzePhoto(photo)).analysis;
    assert.ok(!no.warning.includes(SHOE_PAIR_WARNING), JSON.stringify(thin));
    assert.equal(no.items.length, 1);
  }
});

test("a crop notice is added to a genuine model warning, never replaces it", async () => {
  handler = (_req, res) => streamed(res, reply([goodItem({ box: [10, 10, 12, 12] })], "The photo is blurry."));
  const { analysis } = await analyzePhoto(photo);
  assert.ok(analysis.warning.startsWith("The photo is blurry."));
  assert.match(analysis.warning, /bounds could not be verified/);
  handler = (_req, res) =>
    streamed(res, reply([goodItem({ box: [10, 10, 12, 12] }), goodItem({ name: "Other", box: [0, 0, 5, 5] })], "Dim light."));
  const both = (await analyzePhoto(photo)).analysis.warning;
  for (const part of ["Dim light.", "bounds could not be verified", "More than one item"]) assert.ok(both.includes(part), part);
});

test("a very long model warning is bounded BEFORE the notices are appended: the item is kept, every notice is intact, the whole fits the 500-character schema cap", async () => {
  const longWarning = "The picture is dim and the garment is partly folded over itself near the hem, so details may be missed. ".repeat(30);
  assert.ok(longWarning.length > 2500);
  // Crop notice + several-items notice + a very long model warning (this combination used to fail verification).
  handler = (_req, res) =>
    streamed(res, reply([goodItem({ box: [10, 10, 12, 12] }), goodItem({ name: "Other", box: [0, 0, 5, 5] })], longWarning));
  const several = (await analyzePhoto(photo)).analysis;
  assert.equal(several.items.length, 1);
  assert.ok(several.warning.length <= 500, String(several.warning.length));
  assert.ok(several.warning.startsWith("The picture is dim"), "the real finding is still first");
  assert.match(several.warning, /…/, "and visibly shortened");
  assert.ok(several.warning.includes(CROP_UNVERIFIED_WARNING));
  assert.ok(several.warning.includes(MULTIPLE_ITEMS_WARNING));
  // Crop notice + shoe-pair notice.
  handler = (_req, res) =>
    streamed(res, reply([
      goodItem({ name: "Left sneaker", category: "Shoes", color: "white", box: [100, 400, 450, 800] }),
      goodItem({ name: "Right sneaker", category: "Shoes", color: "white", box: [500, 420, 900, 820] }),
    ], longWarning));
  const pair = (await analyzePhoto(photo)).analysis;
  assert.ok(pair.warning.length <= 500 && pair.warning.includes(SHOE_PAIR_WARNING));
  // Multi mode: crop + crowded notices with the same long warning.
  handler = (_req, res) =>
    streamed(res, JSON.stringify({
      items: Array.from({ length: MAX_DETECTED_ITEMS }, (_, i) => goodItem({ name: `Item ${i}`, box: i === 0 ? [10, 10, 12, 12] : [0, 0, 400, 400] })),
      warning: longWarning,
    }));
  const crowded = (await analyzePhoto(photo, undefined, { mode: "multi" })).analysis;
  assert.ok(crowded.warning.length <= 500 && crowded.warning.includes(CROWDED_WARNING) && crowded.warning.includes(CROP_UNVERIFIED_WARNING));
  // The notice sets the code can actually produce (single: crop with pair OR several; multi: crop with crowded)
  // must always leave room for the model's own text.
  for (const set of [[CROP_UNVERIFIED_WARNING, SHOE_PAIR_WARNING], [CROP_UNVERIFIED_WARNING, MULTIPLE_ITEMS_WARNING], [CROP_UNVERIFIED_WARNING, CROWDED_WARNING]]) {
    const used = set.join(" ").length;
    assert.ok(used < 500 - 100, `notices (${used}) leave at least 100 characters for the model's text`);
  }
});

test("composeWarning: no notices, empty text, exact fit and word-boundary cuts", () => {
  assert.equal(composeWarning("", []), "");
  assert.equal(composeWarning("Short.", []), "Short.");
  assert.equal(composeWarning("", ["A.", "B."]), "A. B.");
  assert.equal(composeWarning("Hi.", ["Notice."]), "Hi. Notice.");
  const exact = composeWarning("x".repeat(100), ["y".repeat(50)], 151);
  assert.equal(exact.length, 151);
  assert.ok(!exact.includes("…"), "fits exactly, so not cut");
  const cut = composeWarning("one two three four five six", ["NOTICE"], 20);
  assert.ok(cut.length <= 20 && cut.endsWith(" NOTICE") && cut.includes("…"), cut);
  assert.ok(!cut.includes("thr…"), "cut at a word boundary where one exists");
  assert.equal(composeWarning("x".repeat(900), []).length, 500);
  // No room for the model's text: the notices alone, never an invalid string.
  assert.equal(composeWarning("model text", ["N".repeat(30)], 31), "N".repeat(30));
});

test("over-long item text from a model that ignores the grammar is cut to the schema caps, not failed and charged", async () => {
  handler = (_req, res) =>
    streamed(res, reply([goodItem({ name: "N".repeat(400), color: "c".repeat(300), pattern: "p".repeat(300), evidence: "e".repeat(900), sleeve: "s".repeat(200) })]));
  const { analysis } = await analyzePhoto(photo);
  const item = analysis.items[0];
  assert.equal(item.name.length, 100);
  assert.equal(item.color.length, 60);
  assert.equal(item.pattern.length, 60);
  assert.equal(item.evidence.length, 250);
  assert.equal(item.sleeve?.length, 60);
});

test("no clothing: an empty list is returned, nothing is invented", async () => {
  handler = (_req, res) => streamed(res, reply([]));
  const { analysis } = await analyzePhoto(photo);
  assert.deepEqual(analysis.items, []);
});

test("an unusable box falls back to the full frame with the existing crop warning", async () => {
  handler = (_req, res) => streamed(res, reply([goodItem({ box: [10, 10, 12, 12] })]));
  const { analysis } = await analyzePhoto(photo);
  assert.deepEqual(analysis.items[0].box, [0, 0, 1, 1]);
  assert.match(analysis.warning, /bounds could not be verified/);
});

test("multi-item mode is still available and unchanged when asked for", async () => {
  handler = (_req, res) =>
    streamed(res, reply([goodItem({ name: "A" }), goodItem({ name: "B", category: "Tops" })]));
  const { analysis } = await analyzePhoto(photo, undefined, { mode: "multi" });
  assert.deepEqual(analysis.items.map((i) => i.name), ["A", "B"]);
  assert.ok(!analysis.warning.includes(MULTIPLE_ITEMS_WARNING));
});

// ---- pure sanitizer, schema and persistence ----

test("refineSingleItem never adds content the model did not give, except the doubts it must record", () => {
  const complete = refineSingleItem({
    name: "x", category: "Tops", color: "red", pattern: "solid", formality: "casual",
    evidence: "e", confidence: 1, material: "", box: [0, 0, 500, 500],
  }) as Record<string, unknown>;
  assert.equal(complete.material, "");
  assert.equal(complete.fit, "unknown");
  assert.deepEqual(complete.seasons, []);
  assert.deepEqual(complete.occasions, []);
  assert.deepEqual(complete.uncertain, [], "nothing flagged for a complete, confident item");
  assert.equal(complete.confidence, 1);
  // A bare item: missing fields become empty/unknown and are FLAGGED, never guessed.
  const bare = refineSingleItem({ name: "x" }) as Record<string, unknown>;
  assert.equal(bare.category, "Unsorted");
  assert.equal(bare.color, "");
  assert.equal(bare.pattern, "");
  assert.equal(bare.formality, "unknown");
  assert.equal(bare.confidence, 0.25);
  assert.deepEqual([...(bare.uncertain as string[])].sort(), ["category", "color", "pattern"]);
  // Not an item at all: left alone, so verification fails instead of a blank item appearing.
  for (const notItem of [null, "text", 5, true, ["a"], undefined]) assert.equal(refineSingleItem(notItem), notItem);
});

test("single-item repairs: empty name stays empty, brand/size are blanked before parsing, out-of-vocabulary values become unknown with the doubt recorded", async () => {
  // Empty name (and no name key at all): the item is kept, unnamed; the multi-item schema is unchanged.
  for (const named of [{ name: "" }, { name: "   " }, { name: undefined }]) {
    handler = (_req, res) => streamed(res, reply([goodItem(named)]));
    const { analysis } = await analyzePhoto(photo);
    assert.equal(analysis.items.length, 1);
    assert.equal(analysis.items[0].name.trim(), "");
    assert.ok(reviewAnalysisSchema.safeParse(analysis).success, "the review accepts an unnamed item");
  }
  assert.ok(!analysisSchema.safeParse({ items: [goodItem({ name: "" })], warning: "" }).success, "multi-item verification still rejects an empty name");
  // Brand and size are blanked even when over-long (the grammar's const was ignored).
  handler = (_req, res) => streamed(res, reply([goodItem({ brand: "B".repeat(500), size: "S".repeat(500) })]));
  const labelled = (await analyzePhoto(photo)).analysis.items[0];
  assert.equal(labelled.brand, "");
  assert.equal(labelled.size, "");
  // Out-of-vocabulary category / formality.
  handler = (_req, res) => streamed(res, reply([goodItem({ category: "Hats", formality: "business", confidence: 1 })]));
  const odd = (await analyzePhoto(photo)).analysis.items[0];
  assert.equal(odd.category, "Unsorted", "the review will not save an Unsorted item until the user chooses");
  assert.equal(odd.formality, "unknown");
  assert.ok(odd.uncertain?.includes("category"));
  assert.ok((odd.confidence ?? 1) <= 0.5, "a score of 1 cannot sit beside a flagged category");
  // Confidence that is not a number in 0..1 is the lowest step, not a hidden failure and not a guess.
  for (const junk of ["high", 85, -1, null, Number.NaN, undefined]) {
    handler = (_req, res) => streamed(res, reply([goodItem({ confidence: junk })]));
    const item = (await analyzePhoto(photo)).analysis.items[0];
    assert.equal(item.confidence, 0.25, String(junk));
    assert.ok(item.uncertain?.includes("category"), String(junk));
  }
  // A valid number is kept as reported (then capped only by stated doubts).
  handler = (_req, res) => streamed(res, reply([goodItem({ confidence: 0.9, uncertain: [] })]));
  assert.equal((await analyzePhoto(photo)).analysis.items[0].confidence, 0.9);
  // Required text that is not text: empty and flagged; optional text that is not text: dropped.
  handler = (_req, res) => streamed(res, reply([goodItem({ color: 5, pattern: { a: 1 }, evidence: 7, sleeve: 3 })]));
  const junkText = (await analyzePhoto(photo)).analysis.items[0];
  assert.equal(junkText.color, "");
  assert.equal(junkText.pattern, "");
  assert.equal(junkText.evidence, "");
  assert.equal(junkText.sleeve, undefined);
  assert.ok(junkText.uncertain?.includes("color") && junkText.uncertain?.includes("pattern"));
});

test("an entry that is not an item at all still fails verification (nothing is invented)", async () => {
  for (const bad of [null, "shirt", 5, [1, 2]]) {
    handler = (_req, res) => streamed(res, reply([bad]));
    await assert.rejects(analyzePhoto(photo), (error: unknown) => {
      assert.ok(error instanceof VisionError);
      assert.equal(error.kind, "unverified", JSON.stringify(bad));
      return true;
    });
  }
});

test("results stored before this build still parse, and the new fields are bounded", () => {
  const old = {
    items: [{ name: "Shirt", category: "Tops", color: "white", pattern: "solid", formality: "casual", brand: "", size: "", confidence: 0.5, evidence: "x", box: [0, 0, 1, 1] }],
    warning: "",
  };
  assert.ok(analysisSchema.safeParse(old).success);
  const bad = structuredClone(old) as { items: Array<Record<string, unknown>> };
  bad.items[0].fit = "tight";
  assert.ok(!analysisSchema.safeParse(bad).success);
  bad.items[0].fit = "regular";
  bad.items[0].seasons = ["spring", "summer", "autumn", "winter", "spring"];
  assert.ok(!analysisSchema.safeParse(bad).success);
});

test("the wardrobe schema stores the new attributes, validates them and still accepts older items", () => {
  const garment = (extra: Record<string, unknown>) => ({
    id: "g1",
    name: "Jacket",
    category: "Outerwear",
    color: "blue",
    brand: "",
    size: "",
    image: "👕",
    ...extra,
  });
  const space = (extra: Record<string, unknown>) => ({
    version: 1,
    name: "Me",
    wardrobe: [garment(extra)],
    looks: [],
  });
  const ok = backupSchema.parse(
    space({ material: "denim", fit: "relaxed", seasons: ["spring"], occasions: ["work", "everyday"] }),
  );
  assert.equal(ok.wardrobe[0].material, "denim");
  assert.deepEqual(ok.wardrobe[0].occasions, ["work", "everyday"]);
  assert.ok(backupSchema.safeParse(space({})).success, "older items without the fields");
  assert.ok(!backupSchema.safeParse(space({ fit: "baggy" })).success);
  assert.ok(!backupSchema.safeParse(space({ seasons: ["monsoon"] })).success);
  assert.ok(!backupSchema.safeParse(space({ material: "x".repeat(61) })).success);
  // `uncertain` is a review aid and is not part of the stored item.
  const stripped = backupSchema.parse(space({ uncertain: ["color"] }));
  assert.equal("uncertain" in stripped.wardrobe[0], false);
});
