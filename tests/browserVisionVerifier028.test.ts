import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_ANALYSIS_TIMEOUT_MS,
  REVIEW_HEADING_NAME,
  addButtonName,
  buildEvidence,
  collectModelEvidence,
  evidenceProblems,
  parseAnalysisTimeout,
  pollOutcome,
  resolveAppUrl,
  reviewHeadingCount,
  sanitizeAlert,
  stampOf,
  writeEvidenceFile,
  type ModelDeps,
  type PageReading,
} from "../scripts/browser-vision-logic";
import { makeTempDir, removeTempDir } from "./helpers/tempDir";

/** Build 028: the logic of the real-model browser verifier. No browser, model or network is used here. */

const root = process.cwd();

test("APP_URL is read as an origin, defaults to local port 3000, and malformed values are refused", () => {
  assert.equal(resolveAppUrl(undefined), "http://127.0.0.1:3000");
  assert.equal(resolveAppUrl("  "), "http://127.0.0.1:3000");
  assert.equal(resolveAppUrl("http://127.0.0.1:3100"), "http://127.0.0.1:3100");
  assert.equal(resolveAppUrl("http://localhost:4000/"), "http://localhost:4000");
  assert.equal(resolveAppUrl("https://style.example.test"), "https://style.example.test");
  for (const bad of ["not a url", "ftp://127.0.0.1:3000", "http://user:pw@127.0.0.1:3000", "http://127.0.0.1:3000/app", "http://127.0.0.1:3000/?x=1", "http://127.0.0.1:3000/#f", "127.0.0.1:3000"])
    assert.throws(() => resolveAppUrl(bad), /APP_URL/, bad);
  // the refusal never echoes the value (it might carry a credential)
  try {
    resolveAppUrl("http://user:hunter2@127.0.0.1:3000");
  } catch (e) {
    assert.ok(!(e as Error).message.includes("hunter2"));
  }
});

test("the analysis timeout is bounded and explicit", () => {
  assert.equal(parseAnalysisTimeout(undefined), DEFAULT_ANALYSIS_TIMEOUT_MS);
  assert.equal(parseAnalysisTimeout("90000"), 90000);
  for (const bad of ["abc", "1.5", "-1", "4999", "900001", "1e5"]) assert.throws(() => parseAnalysisTimeout(bad), /VERIFY_ANALYSIS_TIMEOUT_MS/, bad);
});

test("the review heading is recognised singular and plural, and only when its number agrees with its noun", () => {
  assert.equal(reviewHeadingCount("Review 1 detected item"), 1);
  assert.equal(reviewHeadingCount("Review 2 detected items"), 2);
  assert.equal(reviewHeadingCount("  Review 12   detected\n items "), 12);
  // the exact bug: the old verifier waited for text the product never renders
  assert.equal(reviewHeadingCount("Review 1 detected items"), null);
  assert.equal(reviewHeadingCount("Review 2 detected item"), null);
  for (const bad of ["Review 0 detected items", "Review detected items", "Review 1 detected itemsX", "review 1 detected item", "No clothing was detected.", "", null, undefined]) assert.equal(reviewHeadingCount(bad), null, String(bad));
  assert.ok(REVIEW_HEADING_NAME.test("Review 1 detected item") && REVIEW_HEADING_NAME.test("Review 3 detected items") && !REVIEW_HEADING_NAME.test("Review one detected item"));
});

test("the confirm button name follows the product's singular/plural wording", () => {
  assert.ok(addButtonName(1).test("Add 1 item to my wardrobe"));
  assert.ok(!addButtonName(1).test("Add 1 items to my wardrobe"));
  assert.ok(addButtonName(2).test("Add 2 items to my wardrobe"));
  assert.ok(!addButtonName(2).test("Add 2 item to my wardrobe"));
});

// ------------------------------------------------------------------ polling

function clock() {
  let t = 1000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
}
const empty: PageReading = { heading: null, alert: null };

test("polling succeeds as soon as the singular heading shows, with the elapsed time", async () => {
  const c = clock();
  let reads = 0;
  const out = await pollOutcome(async () => (++reads < 4 ? empty : { heading: "Review 1 detected item", alert: null }), { timeoutMs: 60_000, now: c.now, sleep: c.sleep });
  assert.deepEqual(out, { kind: "review", count: 1, elapsedMs: 1500 });
});

test("polling fails quickly with the product alert instead of waiting for the full timeout", async () => {
  const c = clock();
  let reads = 0;
  const out = await pollOutcome(async () => (++reads < 3 ? empty : { heading: null, alert: "  The analysis service is not available.\n Try again later. " }), { timeoutMs: 250_000, now: c.now, sleep: c.sleep });
  assert.equal(out.kind, "alert");
  assert.equal(out.kind === "alert" && out.text, "The analysis service is not available. Try again later.");
  assert.ok(out.elapsedMs < 5000, "failed in seconds, not after the 250 s wait");
});

test("polling times out when neither a heading nor an alert appears, and the timeout is the configured one", async () => {
  const c = clock();
  const out = await pollOutcome(async () => empty, { timeoutMs: 10_000, intervalMs: 1000, now: c.now, sleep: c.sleep });
  assert.equal(out.kind, "timeout");
  assert.ok(out.elapsedMs >= 10_000 && out.elapsedMs < 12_000);
});

test("a heading wins over an alert seen in the same reading, and a wrong-number heading is not success", async () => {
  const c = clock();
  const both = await pollOutcome(async () => ({ heading: "Review 1 detected item", alert: "Saved a draft." }), { timeoutMs: 1000, now: c.now, sleep: c.sleep });
  assert.equal(both.kind, "review");
  const wrong = await pollOutcome(async () => ({ heading: "Review 1 detected items", alert: null }), { timeoutMs: 2000, intervalMs: 500, now: c.now, sleep: c.sleep });
  assert.equal(wrong.kind, "timeout", "the old, incorrect wording is never accepted");
  const blank = await pollOutcome(async () => ({ heading: null, alert: "   " }), { timeoutMs: 1000, intervalMs: 500, now: c.now, sleep: c.sleep });
  assert.equal(blank.kind, "timeout", "an empty alert region is not a failure");
});

test("alert text is bounded and whitespace-collapsed", () => {
  assert.equal(sanitizeAlert(null), "");
  assert.equal(sanitizeAlert("a\n\n  b"), "a b");
  assert.equal(sanitizeAlert("x".repeat(500)).length, 300);
});

// ------------------------------------------------------------------ model evidence

const identity = { mode: "single", promptSha256: "a".repeat(64), requestSha256: "b".repeat(64) };
const tags = (models: unknown) => async () => ({ ok: true, json: async () => ({ models }) });
const deps = (over: Partial<ModelDeps> = {}): ModelDeps => ({ configuredModel: () => ({ ok: true, name: "qwen3-vl" }), requestIdentity: () => identity, ollamaUrl: () => "http://127.0.0.1:11434", fetch: tags([{ name: "qwen3-vl:latest", digest: "ABCDEF0123456789abcdef" }, { name: "other:1", digest: "ffffffffffff" }]), ...over });

test("model evidence has the configured name, the digest of THAT model, and the request identity", async () => {
  const m = await collectModelEvidence(deps());
  assert.deepEqual(m, { configuredModel: "qwen3-vl", modelDigest: "abcdef0123456789abcdef", digestNote: "digest reported by the local Ollama runtime", request: identity });
});

test("a missing digest never fails collection: unreachable Ollama, unlisted model, bad digest, bad HTTP status", async () => {
  const unreachable = await collectModelEvidence(deps({ fetch: async () => { throw new Error("connect ECONNREFUSED http://127.0.0.1:11434"); } }));
  assert.equal(unreachable.modelDigest, null);
  assert.ok(!unreachable.digestNote.includes("ECONNREFUSED") && !unreachable.digestNote.includes("11434"));
  assert.equal((await collectModelEvidence(deps({ fetch: tags([{ name: "other:1", digest: "ffffffffffff" }]) }))).modelDigest, null);
  assert.equal((await collectModelEvidence(deps({ fetch: tags([{ name: "qwen3-vl", digest: "not hex!" }]) }))).modelDigest, null);
  assert.equal((await collectModelEvidence(deps({ fetch: async () => ({ ok: false, json: async () => ({}) }) }))).modelDigest, null);
  const invalid = await collectModelEvidence(deps({ configuredModel: () => ({ ok: false }) }));
  assert.equal(invalid.configuredModel, null);
  assert.match(invalid.digestNote, /not a valid model name/);
  const noIdentity = await collectModelEvidence(deps({ requestIdentity: () => { throw new Error("x"); } }));
  assert.equal(noIdentity.request, null);
});

// ------------------------------------------------------------------ evidence

const baseInput = () => ({
  passed: true,
  startedAt: "2026-11-10T09:00:00.000Z",
  elapsedMs: 91_234,
  appOrigin: "http://127.0.0.1:3100",
  model: { configuredModel: "qwen3-vl", modelDigest: "abcdef0123456789abcdef", digestNote: "digest reported by the local Ollama runtime", request: identity },
  detectedItemCount: 1,
  completedChecks: ["app reachable", "reload persistence"],
  failedStep: null,
  failureReason: null,
  productAlert: null,
  screenshots: ["live-browser-20261110T090000Z-review.png"],
});

test("evidence has exactly the documented fields, rounds the time, and claims no accuracy", () => {
  const e = buildEvidence(baseInput());
  assert.deepEqual(Object.keys(e).sort(), ["appOrigin", "completedChecks", "detectedItemCount", "elapsedSeconds", "failedStep", "failureReason", "kind", "model", "note", "passed", "productAlert", "schemaVersion", "scope", "screenshots", "startedAt"]);
  assert.equal(e.elapsedSeconds, 91.2);
  assert.match(e.note, /measures no recognition accuracy/);
  assert.match(e.scope, /crowded photos are out of scope/);
  assert.deepEqual(evidenceProblems(e), []);
  const failed = buildEvidence({ ...baseInput(), passed: false, failedStep: "wait for the real model analysis", failureReason: "no review heading", productAlert: "The model is not available.", completedChecks: [] });
  assert.equal(failed.productAlert, "The model is not available.");
  assert.deepEqual(evidenceProblems(failed), []);
});

test("evidence containing base64, data URIs, credentials, e-mail addresses or data-directory paths is refused", () => {
  const bad = (patch: Record<string, unknown>) => evidenceProblems({ ...buildEvidence(baseInput()), ...patch });
  assert.ok(bad({ productAlert: `data:image/jpeg;base64,${"A".repeat(40)}` }).length > 0);
  assert.ok(bad({ failureReason: "A".repeat(250) }).length > 0, "a long base64-looking run");
  assert.ok(bad({ productAlert: "sign in as vision-123@example.test failed" }).length > 0);
  assert.ok(bad({ password: "x" }).length > 0);
  assert.ok(bad({ model: { cookie: "x" } }).length > 0);
  assert.ok(bad({ failureReason: "cannot open C:\\work\\style-app\\.data\\app.db" }).length > 0);
  assert.ok(bad({ failureReason: "STYLE_DATA_DIR is not writable" }).length > 0);
  assert.ok(bad({ failureReason: "y".repeat(401) }).length > 0);
});

test("evidence files are created exclusively and an earlier run is never overwritten", () => {
  const dir = makeTempDir("s028-");
  try {
    const sub = path.join(dir, "evidence");
    const first = writeEvidenceFile(sub, "live-browser-20261110T090000Z-pass", "json", "first");
    assert.equal(first, "live-browser-20261110T090000Z-pass.json");
    const second = writeEvidenceFile(sub, "live-browser-20261110T090000Z-pass", "json", "second");
    assert.equal(second, "live-browser-20261110T090000Z-pass-2.json");
    assert.equal(readFileSync(path.join(sub, first), "utf8"), "first", "the earlier evidence is untouched");
    const third = writeEvidenceFile(sub, "live-browser-20261110T090000Z-pass", "json", "third");
    assert.equal(third, "live-browser-20261110T090000Z-pass-3.json");
    // a file that appears between the existence check and the create (a racing verifier) is not overwritten
    writeFileSync(path.join(sub, "race.png"), "winner");
    const raced = writeEvidenceFile(sub, "race", "png", Buffer.from([1, 2, 3]), () => false);
    assert.equal(raced, "race-2.png");
    assert.equal(readFileSync(path.join(sub, "race.png"), "utf8"), "winner");
    assert.deepEqual(readdirSync(sub).sort(), ["live-browser-20261110T090000Z-pass-2.json", "live-browser-20261110T090000Z-pass-3.json", "live-browser-20261110T090000Z-pass.json", "race-2.png", "race.png"]);
  } finally {
    removeTempDir(dir, "s028-");
  }
});

test("file-name stamps are sortable UTC and contain no separators", () => {
  assert.equal(stampOf(new Date("2026-11-10T09:30:45.123Z")), "20261110T093045Z");
});

// ------------------------------------------------------------------ the driver and the product agree

test("the driver reads APP_URL, uses the shared logic, keeps the unique account and has no stale wording or secrets", () => {
  const driver = readFileSync(path.join(root, "scripts", "verify-browser-vision.ts"), "utf8");
  assert.match(driver, /resolveAppUrl\(process\.env\.APP_URL\)/);
  assert.ok(!/127\.0\.0\.1:3000|localhost:3000/.test(driver), "no hard-coded port");
  assert.ok(!/Review 1 detected items/.test(driver), "the stale exact text is gone");
  assert.ok(!/Add 1 items/.test(driver));
  assert.match(driver, /verificationAccount\(origin\)/);
  assert.match(driver, /pollOutcome/);
  assert.match(driver, /evidenceProblems\(evidence\)/);
  assert.ok(!/base64|toString\("base64"\)/.test(driver), "images are never embedded in evidence");
  assert.ok(!/live-browser\.json|live-upload\.png|live-wardrobe\.png/.test(driver), "fixed names that overwrite prior evidence are gone");
  const account = readFileSync(path.join(root, "scripts", "verification-account.ts"), "utf8");
  assert.match(account, /randomUUID\(\)\}@example\.test/);
  assert.match(account, /url: appOrigin/);
});

test("the product still renders the wording the verifier waits for", () => {
  const dialog = readFileSync(path.join(root, "src", "components", "UploadDialog.tsx"), "utf8").replace(/\s+/g, " ");
  assert.match(dialog, /Review \{drafts\.length\} detected\{" "\} \{drafts\.length === 1 \? "item" : "items"\}/);
  assert.match(dialog, /Add \{drafts\.length\} \{drafts\.length === 1 \? "item" : "items"\} to my/);
  assert.match(dialog, /role="alert"/);
});

test("documentation tells the operator how to run it and says it measures no accuracy", () => {
  assert.ok(existsSync(path.join(root, "README.md")));
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /APP_URL/);
  assert.match(readme, /verify-browser-vision/);
  assert.match(readme, /VERIFY_EVIDENCE_DIR/);
  assert.match(readme, /not (a )?(calibrated )?(recognition )?(benchmark|accuracy)/i);
});
