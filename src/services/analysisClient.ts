/**
 * Browser-side helpers for the photo-analysis job API. Every call is verified
 * by the server against the signed-in session; nothing here trusts stored ids.
 */

export type JobStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";

export type JobSummary = {
  id: string;
  status: JobStatus;
  createdAt?: number;
  /** Absolute server deadline for the photo and its result (epoch ms). */
  expiresAt?: number;
  serverNow?: number;
  position?: number;
  estimatedStartMs?: number;
  estimatedReadyMs?: number;
  refunded?: boolean;
  error?: string;
  result?: unknown;
};

export const isActive = (job: Pick<JobSummary, "status">) =>
  job.status === "queued" || job.status === "running";

async function readJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

/** Owner-only list of active and recent jobs (no result payloads). */
export async function listJobs(signal?: AbortSignal): Promise<JobSummary[]> {
  const response = await fetch("/api/analysis-jobs", {
    cache: "no-store",
    signal,
  });
  if (!response.ok) return [];
  const data = await readJson(response);
  return Array.isArray(data.jobs) ? (data.jobs as JobSummary[]) : [];
}

export class JobGoneError extends Error {}

export async function getJob(
  id: string,
  signal?: AbortSignal,
): Promise<JobSummary> {
  const response = await fetch(`/api/analysis-jobs/${encodeURIComponent(id)}`, {
    cache: "no-store",
    signal,
  });
  const data = await readJson(response);
  if (response.status === 404)
    throw new JobGoneError("This photo is no longer available. Upload it again.");
  if (!response.ok)
    throw new Error(data.error || "Photo analysis could not be checked.");
  return data as JobSummary;
}

/**
 * Cancels a queued/running job or discards a finished one. Throws when the
 * server did not confirm, so callers can show the failure instead of
 * pretending it worked.
 */
export async function discardJob(
  id: string,
  accountId: string,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  const response = await fetch(`/api/analysis-jobs/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-Style-Account": accountId },
    keepalive: options.keepalive,
  });
  if (response.ok || response.status === 404) return;
  const data = await readJson(response);
  throw new Error(data.error || "Could not cancel. Please try again.");
}

/*
 * A result whose wardrobe save was acknowledged but whose server-side discard
 * failed is remembered in this tab (ids only, per account) so it is not
 * offered for review again and the discard is retried later. The server's own
 * one-hour expiry remains the backstop.
 */
const PENDING_PREFIX = "style-discard:";
export function markDiscardPending(accountId: string, jobId: string) {
  try {
    sessionStorage.setItem(`${PENDING_PREFIX}${accountId}:${jobId}`, "1");
  } catch {
    // Storage unavailable: the job is simply still listed until it expires.
  }
}
export function pendingDiscards(accountId: string): string[] {
  const own = `${PENDING_PREFIX}${accountId}:`;
  const ids: string[] = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(own)) ids.push(key.slice(own.length));
    }
  } catch {
    // Ignore.
  }
  return ids;
}
export function clearPendingDiscard(accountId: string, jobId: string) {
  try {
    sessionStorage.removeItem(`${PENDING_PREFIX}${accountId}:${jobId}`);
  } catch {
    // Ignore.
  }
}
/** Retries remembered discards; forgets each one the server confirms. */
export async function retryPendingDiscards(accountId: string): Promise<string[]> {
  const ids = pendingDiscards(accountId);
  for (const id of ids) {
    try {
      await discardJob(id, accountId);
      clearPendingDiscard(accountId, id);
    } catch {
      // Still pending.
    }
  }
  return pendingDiscards(accountId);
}

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

/** Plain-language status for a queued or running job. */
export function describeProgress(job: JobSummary): string {
  if (job.status === "running")
    return job.estimatedReadyMs !== undefined
      ? `Finding the clothes in your photo… about ${minutes(job.estimatedReadyMs)} min left.`
      : "Finding the clothes in your photo…";
  if (job.status === "queued") {
    const place = job.position ? `Your photo is number ${job.position} in line` : "Your photo is waiting its turn";
    return job.estimatedReadyMs !== undefined
      ? `${place}. Ready in about ${minutes(job.estimatedReadyMs)} min.`
      : `${place}.`;
  }
  return "";
}

/** "try again in about N min" from a Retry-After style hint. */
export function retryText(seconds: unknown): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "";
  return value < 90
    ? " Try again in about a minute."
    : ` Try again in about ${Math.ceil(value / 60)} minutes.`;
}
