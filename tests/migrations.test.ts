import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
test("separate cold-start processes safely share account migrations", async () => {
  const directory = path.join(process.cwd(), ".data", "tests", randomUUID());
  const run = () =>
    new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "scripts/init-auth.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            STYLE_DATA_DIR: directory,
            STYLE_PUBLIC_DEPLOYMENT: "false",
            APP_URL: "http://127.0.0.1:3000",
          },
          windowsHide: true,
        },
      );
      let output = "";
      child.stdout.on("data", (data) => (output += data));
      child.stderr.on("data", (data) => (output += data));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    });
  const results = await Promise.all([run(), run(), run()]);
  for (const result of results) assert.equal(result.code, 0, result.output);
  const db = new DatabaseSync(path.join(directory, "app.db"));
  assert.equal(
    (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
      .integrity_check,
    "ok",
  );
  for (const table of [
    "user",
    "session",
    "wardrobe_spaces",
    "photo_assets",
    "analysis_jobs",
    "mutation_limits",
  ])
    assert.ok(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table),
    );
  db.close();
});
