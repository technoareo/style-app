"use client";
import { useEffect, useState } from "react";
import {
  isActive,
  listJobs,
  pendingDiscards,
  type JobSummary,
} from "../services/analysisClient";

/**
 * The signed-in account's active and recent photo-analysis jobs, fetched from
 * the server (owner-only). Polls while a job is queued or running; otherwise
 * refreshes only when `refreshKey` changes (for example when the upload
 * dialog opens or closes). A failed fetch keeps the previous value.
 */
export function useAnalysisJobs(
  refreshKey: unknown,
  accountId: string,
): JobSummary[] {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ac = new AbortController();
    async function tick() {
      try {
        const hidden = new Set(pendingDiscards(accountId));
        const next = (await listJobs(ac.signal)).filter(
          (j) => !hidden.has(j.id),
        );
        if (!alive) return;
        setJobs(next);
        if (next.some(isActive)) timer = setTimeout(tick, 6000);
      } catch {
        if (alive) timer = setTimeout(tick, 15_000);
      }
    }
    void tick();
    return () => {
      alive = false;
      ac.abort();
      clearTimeout(timer);
    };
  }, [refreshKey, accountId]);
  return jobs;
}
