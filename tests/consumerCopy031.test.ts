import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { ANSWER_CUT_MESSAGE, TOO_SLOW_MESSAGE } from "../src/server/vision";

/**
 * Build 031: consumer-facing truthfulness. The supported workflow is EASY SINGLE-ITEM detection: the default
 * consumer copy asks for exactly one clothing item per photo and never invites several. The multi-item mode
 * (STYLE_ANALYSIS_MODE=multi) stays as an operator rollback, so its code and its own warning text are NOT touched
 * and these tests do not look at them. Source assertions on whitespace-normalised text, not snapshots.
 */

const root = process.cwd();
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
/** Source text without comments, whitespace collapsed (JSX wraps lines arbitrarily). */
const text = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/\s+/g, " ");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx$/.test(name)) out.push(rel);
  }
  return out;
}

/** Wording that invites more than one item in a photo. */
const INVITES_SEVERAL = /\bone item or (several|more|many|multiple)\b|\bone or (more|several|many|multiple) (items|pieces|garments) (in|per|from|on) (a|one|each|your|the same) (photo|picture|image)\b|\b(several|multiple|many) (items|pieces|garments) (in|per|from|on) (a|one|each|your|the same) (photo|picture|image)\b|\bupload (a )?(crowded|group)\b|\bphotos? (of|with) (several|multiple|many|all)\b|\b(full|whole) (rack|closet|wardrobe) (photo|shot)\b/i;

test("the upload banner asks for exactly one clothing item per photo and says local AI proposes details that the user reviews and corrects", () => {
  const view = text("src/components/WardrobeView.tsx");
  assert.match(view, /Use exactly one clothing item per photo\. Local AI proposes its details, and you review and correct them\./);
  assert.match(view, /<b>Upload a photo of each clothing item<\/b>/);
  assert.match(view, /JPEG, PNG or WebP · Up to 6 MB · One item, fully visible, in good light\./);
  assert.doesNotMatch(view, /One item or several/i, "the stale multi-item promise is gone");
  assert.doesNotMatch(view, INVITES_SEVERAL);
  assert.doesNotMatch(view, /Local AI finds visible pieces/, "no promise that every piece in a photo is found");
  const banner = view.slice(view.indexOf('className="upload-banner"'), view.indexOf('onClick={onUpload}'));
  assert.ok(banner.includes("Use exactly one clothing item per photo."), "the banner slice is the real banner");
  // The permanent banner must not contain the phrases the transient review UI owns: tests/e2e/singleItem018.spec.ts
  // asserts getByText(/AI suggests/) and /The AI was unsure/ have count 0 once the user has accepted or cleared a suggestion.
  assert.doesNotMatch(banner, /AI suggests|The AI was unsure|AI guessed/, "the banner does not collide with the review-suggestion wording");
  assert.doesNotMatch(view, /AI suggests/, "WardrobeView never renders the transient suggestion phrase");
  assert.doesNotMatch(banner, /\b(accurate|accuracy|always|reliably|guarantee)/i, "no accuracy claim is invented (none has been measured)");
});

test("the banner's stated limits match the real client-side upload limits", () => {
  const images = read("src/services/images.ts");
  assert.match(images, /\["image\/jpeg", "image\/png", "image\/webp"\]/, "the accepted types are JPEG, PNG and WebP");
  assert.match(images, /smaller than 6 MB/, "the client refuses photos of 6 MB or more");
  const view = text("src/components/WardrobeView.tsx");
  assert.match(view, /JPEG, PNG or WebP · Up to 6 MB/);
  assert.match(read("src/components/UploadDialog.tsx"), /accept="image\/jpeg,image\/png,image\/webp"/);
});

test("the upload dialog's guidance agrees: one item per photo, only the most prominent is listed, nothing about racks or closets working", () => {
  const dialog = text("src/components/UploadDialog.tsx");
  assert.match(dialog, /Photograph one clothing item per photo\./);
  assert.match(dialog, /If several items are visible we list only the most prominent one, so a full rack, shelf or closet will not work\./);
  assert.doesNotMatch(dialog, INVITES_SEVERAL);
});

test("timeout and cut-short messages ask for one clearly visible item, and keep their error kinds", () => {
  assert.equal(TOO_SLOW_MESSAGE, "This photo took too long to analyze. Try a clearer photo with one clothing item clearly visible.");
  assert.equal(ANSWER_CUT_MESSAGE, "The analysis was cut short before it finished. Try a clearer photo with one clothing item clearly visible.");
  for (const m of [TOO_SLOW_MESSAGE, ANSWER_CUT_MESSAGE]) {
    assert.doesNotMatch(m, /one to three|three items|several|multiple|space between them/i, m);
    assert.match(m, /one clothing item/);
  }
  const vision = text("src/server/vision.ts");
  assert.match(vision, /new VisionError\(TOO_SLOW_MESSAGE, "timeout"\)/, "the timeout kind is unchanged");
  assert.match(vision, /new VisionError\(ANSWER_CUT_MESSAGE, "unverified"\)/, "the cut-short kind is unchanged");
  // the operator rollback is untouched: its own warning text and the single-mode guard are still there
  assert.match(vision, /const crowded = !single && found\.length >= MAX_DETECTED_ITEMS/);
  assert.match(vision, /multiple \? MULTIPLE_ITEMS_WARNING : ""/);
});

test("the account dialog no longer says backups are blanket-unencrypted, and does not imply every backup is encrypted, off-server or restore-tested", () => {
  const dialog = text("src/components/AccountDialog.tsx");
  assert.doesNotMatch(dialog, /Backups are not encrypted by the app itself/i, "the stale blanket statement is gone");
  assert.match(dialog, /Deleting your account immediately removes your sign-in, wardrobe, saved looks, photos and any emails still waiting to be sent from the live service\./);
  assert.match(dialog, /server backups made before you deleted, which are kept for up to 7 days by default/);
  assert.match(dialog, /The operator can create encrypted backup packages, and plain local backups may also exist; we do not promise that every backup is encrypted, stored away from the server or tested by restoring it\./);
  assert.match(dialog, /It is not a secure wipe of the server's storage|It is not a secure wipe of the server&apos;s storage/);
  assert.match(dialog, /pseudonymous deletion record/);
  // The ONE sentence allowed to name "every backup is encrypted ..." is the negated disclaimer, whose exact text is
  // asserted above. Remove it, then no unconditional positive claim may remain anywhere in the dialog.
  const disclaimer = "we do not promise that every backup is encrypted, stored away from the server or tested by restoring it";
  assert.equal(dialog.split(disclaimer).length - 1, 1, "the negated disclaimer appears exactly once");
  const rest = dialog.replace(disclaimer, " ");
  assert.doesNotMatch(rest, POSITIVE_BACKUP_CLAIM, "an unconditional claim about backups remains in the dialog");
  assert.doesNotMatch(rest, /\b(encrypted|safe|secure) (off-?site|off the server|elsewhere)\b/i);
});

/** An unconditional positive statement about backups: "every backup is encrypted", "all backups are stored off-server", "backups are tested". */
const POSITIVE_BACKUP_CLAIM = /\b(all|every|each) backups? (is|are) (also |always |fully |automatically )?(encrypted|copied|stored|kept off|tested|restore-tested|restored)|\bbackups? (is|are) (also |always |fully |automatically )?(encrypted|copied off|stored off|off-?site|restore-tested|tested)|\b(all|every|each) backups?\b[^.]{0,40}\b(encrypted|off-?server|off-?site|restore-tested)\b/i;

test("the backup-claim guard still rejects real positive claims and accepts the negated disclaimer", () => {
  for (const bad of [
    "Every backup is encrypted.",
    "All backups are stored off-server.",
    "Each backup is tested by restoring it.",
    "Backups are always encrypted.",
    "All backups are copied off the server.",
    "Every backup is restore-tested.",
    "Backups are encrypted and kept off-site.",
  ])
    assert.match(bad, POSITIVE_BACKUP_CLAIM, bad);
  for (const ok of [
    "Server backups made before you deleted are kept for up to 7 days by default.",
    "The operator can create encrypted backup packages, and plain local backups may also exist.",
    "Deleting your account removes your photos from the live service.",
  ])
    assert.doesNotMatch(ok, POSITIVE_BACKUP_CLAIM, ok);
  // the disclaimer itself would trip the pattern, which is exactly why it is removed by exact text before the check
  assert.match("we do not promise that every backup is encrypted, stored away from the server or tested by restoring it", POSITIVE_BACKUP_CLAIM);
});

test("no default consumer screen promises that several or crowded items in one photo are supported", () => {
  const files = [...walk("src/components"), ...walk("src/app")];
  assert.ok(files.length > 10, "the scan covers the real component set");
  for (const f of files) assert.doesNotMatch(text(f), INVITES_SEVERAL, `${f} invites several items in one photo`);
  // the detector works (it would catch the old banner)
  assert.match("One item or several in a photo.", INVITES_SEVERAL);
  assert.match("Upload a crowded photo of your closet", INVITES_SEVERAL);
  assert.doesNotMatch("Use exactly one clothing item per photo.", INVITES_SEVERAL);
});

test("the notes record the scope honestly and claim no launch readiness", () => {
  const notes = read("docs/reviews/implementation-031-notes.md");
  for (const re of [/single-item/i, /rollback/i, /not launch-ready/i, /rights-cleared/i, /hosting/i, /domain/i, /TLS/, /SMTP/, /off-server/i, /capacity/i, /legal identity|contact details/i, /Backups are not encrypted by the app itself/]) assert.match(notes, re, String(re));
  for (const l of notes.split("\n"))
    if (/ready to launch|launch[- ]ready|launch readiness|production[- ]ready/i.test(l)) assert.match(l, /no claim|not |never|cannot|until|remain|open|unverified|without/i, l.slice(0, 120));
});
