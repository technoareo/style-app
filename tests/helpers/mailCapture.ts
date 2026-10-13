import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Reads the private local mail capture (`<data dir>/mail-outbox/*.json`).
 *
 * Since build 008 capture is EVENTUAL: requests only enqueue into the durable
 * outbox and a drain (the web process, or the mail worker) writes the capture
 * file a few tens of milliseconds later. Tests must therefore poll with
 * {@link waitForMail} instead of reading the folder right after a request.
 */
export type CapturedMail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  capturedAt: string;
};

export function capturedMail(dataDir: string): CapturedMail[] {
  const dir = path.join(dataDir, "mail-outbox");
  if (!existsSync(dir)) return [];
  const out: CapturedMail[] = [];
  for (const file of readdirSync(dir).sort()) {
    try {
      out.push(JSON.parse(readFileSync(path.join(dir, file), "utf8")));
    } catch {
      // A file being written right now; the next poll sees it whole.
    }
  }
  return out;
}

/** Latest captured message matching `to` and a subject fragment; polls up to `timeoutMs`. */
export async function waitForMail(
  dataDir: string,
  to: string,
  subject: string,
  timeoutMs = 15_000,
): Promise<CapturedMail> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const found = capturedMail(dataDir)
      .filter((m) => m.to === to && m.subject.includes(subject))
      .at(-1);
    if (found) return found;
    if (Date.now() > end)
      throw new Error(`No "${subject}" mail captured for ${to} in time.`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The link in a captured message's text part ("Label: <url>"). */
export const linkOf = (mail: CapturedMail) =>
  new URL(mail.text.split(": ").slice(1).join(": "));
