import type { DatabaseSync } from "node:sqlite";

/**
 * Better Auth stores its rate limiter in the database (`rateLimit: { storage:
 * "database" }` in auth.ts). Its model is `rateLimit` with the columns `key`,
 * `count` and `lastRequest`, and the key is `<client ip>|<path>` (see
 * node_modules/@better-auth/core/dist/utils/ip.mjs `createRateLimitKey`), so the
 * table holds client IP addresses. Backups and restores clear it.
 *
 * The physical table name is read from the database instead of assumed: any
 * ordinary table named rateLimit / rate_limit (any case). Only names that are
 * plain identifiers are returned, so they are safe to quote into a statement.
 */
export function rateLimitTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND lower(name) IN ('ratelimit','rate_limit')",
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
}

export function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?")
      .get(name),
  );
}
