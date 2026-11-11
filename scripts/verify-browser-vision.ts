import { chromium, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  EVIDENCE_CHECKS,
  REVIEW_HEADING_NAME,
  addButtonName,
  buildEvidence,
  collectModelEvidence,
  evidenceProblems,
  parseAnalysisTimeout,
  pollOutcome,
  resolveAppUrl,
  sanitizeAlert,
  stampOf,
  writeEvidenceFile,
  type Evidence,
  type ModelEvidence,
  type PageReading,
} from "./browser-vision-logic";
import { verificationAccount } from "./verification-account";

/**
 * Operator-owned real-model browser verification (build 028).
 *
 *   APP_URL=http://127.0.0.1:3100 npx tsx scripts/verify-browser-vision.ts
 *
 * Needs the app, the analysis worker and Ollama with the configured vision model running, and local development
 * mail capture (it creates one disposable account with a unique random identity each run; the identity is never
 * written anywhere). Drives a real Chrome through: upload one public photo -> real model analysis -> review ->
 * save -> reload. Writes NEW evidence files every run (JSON and screenshots under VERIFY_EVIDENCE_DIR, default
 * docs/verification/live); nothing earlier is overwritten. It is a flow check, not a recognition benchmark.
 *
 * Exit code 0: every check passed. 1: it did not; the evidence names the failed step and the product alert.
 */

const PHOTO = resolve("tests/fixtures/public-shirt.jpg");

async function readPage(page: Page): Promise<PageReading> {
  try {
    const headings = page.getByRole("heading", { name: REVIEW_HEADING_NAME });
    const heading = (await headings.count()) > 0 ? await headings.first().innerText() : null;
    const alerts = (await page.getByRole("alert").allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    return { heading, alert: alerts.length ? alerts.join(" | ") : null };
  } catch {
    return { heading: null, alert: null }; // the page is mid-navigation; the next poll reads again
  }
}

async function main(): Promise<number> {
  const origin = resolveAppUrl(process.env.APP_URL);
  const timeoutMs = parseAnalysisTimeout(process.env.VERIFY_ANALYSIS_TIMEOUT_MS);
  const evidenceDir = process.env.VERIFY_EVIDENCE_DIR?.trim() || "docs/verification/live";
  const startedAt = new Date();
  const base = `live-browser-${stampOf(startedAt)}`;
  const t0 = performance.now();
  const completed: string[] = [];
  const screenshots: string[] = [];
  let step = "start";
  let detected: number | null = null;
  let alert: string | null = null;
  let reason: string | null = null;
  let page: Page | null = null;

  // Model identity: names and hashes only. Read from the same environment files the app reads.
  const { loadLocalEnvFiles } = await import("../src/server/localEnv");
  loadLocalEnvFiles({ dir: process.cwd() });
  const vision = await import("../src/server/vision");
  const model: ModelEvidence = await collectModelEvidence({
    configuredModel: () => vision.configuredVisionModel(),
    requestIdentity: () => vision.visionRequestIdentity("single"),
    ollamaUrl: () => vision.ollamaUrl(),
    fetch: (url, init) => fetch(url, { ...init, cache: "no-store" }),
  });

  const shot = async (label: string) => {
    if (!page) return;
    try {
      const png = await page.screenshot({ fullPage: true });
      screenshots.push(writeEvidenceFile(evidenceDir, `${base}-${label}`, "png", png));
    } catch {
      /* evidence is best effort; the verdict does not depend on it */
    }
  };
  const done = (check: (typeof EVIDENCE_CHECKS)[number]) => completed.push(check);

  const browser = await chromium.launch({ channel: "chrome" });
  try {
    step = "open the app";
    const account = await verificationAccount(origin);
    done("disposable account signed in");
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.context().addCookies(account.cookies);
    await page.goto(origin);
    done("app reachable");

    step = "upload a photo";
    await page.getByRole("button", { name: "Add my clothes", exact: true }).click();
    await page.getByLabel("Allow the server to analyze this photo.").check();
    await page.getByLabel("Choose a clothing photo", { exact: true }).setInputFiles(PHOTO);
    done("photo upload accepted (browser normalization)");

    step = "wait for the real model analysis";
    const outcome = await pollOutcome(() => readPage(page as Page), {
      timeoutMs,
      now: () => performance.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    if (outcome.kind === "alert") {
      alert = outcome.text;
      throw new Error(`the product reported a problem after ${Math.round(outcome.elapsedMs / 1000)} s`);
    }
    if (outcome.kind === "timeout") throw new Error(`no review heading and no product alert within ${Math.round(timeoutMs / 1000)} s`);
    detected = outcome.count;
    done("real model analysis completed");
    done("review heading shown");
    if (detected !== 1) throw new Error(`expected exactly 1 detected item for the single-item photo, the page shows ${detected}`);
    await shot("review");

    step = "confirm and save the review";
    await page.getByLabel("Details checked").check();
    await page.getByRole("button", { name: addButtonName(detected) }).click();
    await page.getByText(/all changes saved/i).first().waitFor({ timeout: 30_000 });
    done("review confirmed and saved");

    step = "reload and find the saved item";
    await page.reload();
    await page.getByRole("complementary").getByRole("button", { name: "My wardrobe", exact: true }).click();
    await page.getByRole("button", { name: /^Edit /i }).first().waitFor({ timeout: 30_000 });
    done("reload persistence");
    await shot("wardrobe");

    return finish(true);
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
    if (alert === null && page) alert = (await readPage(page)).alert;
    await shot("failure");
    return finish(false);
  } finally {
    await browser.close();
  }

  function finish(passed: boolean): number {
    const evidence: Evidence = buildEvidence({
      passed,
      startedAt: startedAt.toISOString(),
      elapsedMs: performance.now() - t0,
      appOrigin: origin,
      model,
      detectedItemCount: detected,
      completedChecks: completed,
      failedStep: passed ? null : step,
      failureReason: passed ? null : reason,
      productAlert: alert === null ? null : sanitizeAlert(alert),
      screenshots,
    });
    const problems = evidenceProblems(evidence);
    if (problems.length > 0) {
      console.error(`Evidence not written because it failed the privacy check: ${problems.join("; ")}`);
      return 1;
    }
    const name = writeEvidenceFile(evidenceDir, `${base}-${passed ? "pass" : "fail"}`, "json", `${JSON.stringify(evidence, null, 2)}\n`);
    if (passed) console.log(`Live browser verification passed in ${evidence.elapsedSeconds} s (${completed.length} checks). Evidence: ${evidenceDir}/${name}. This is a flow check, not an accuracy measurement.`);
    else {
      console.error(`Live browser verification FAILED at "${step}": ${reason}${evidence.productAlert ? `\nProduct alert: ${evidence.productAlert}` : ""}\nEvidence: ${evidenceDir}/${name}`);
    }
    return passed ? 0 : 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  },
);
