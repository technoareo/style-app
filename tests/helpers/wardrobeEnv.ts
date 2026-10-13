import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Environment for the build-015 wardrobe tests. This module has NO imports from
 * src/ on purpose: a test file imports it FIRST, so these assignments run
 * before any module that reads the environment is evaluated (static imports
 * run in order). Mirrors accounts.test.ts: a private data directory, the same
 * APP_URL, and no SMTP_URL / public mode, so account mail goes to the local
 * capture folder (tests/helpers/mailCapture.ts) and never to a real relay.
 */
export const dataDir = path.join(process.cwd(), ".data", "tests", randomUUID());
process.env.STYLE_DATA_DIR = dataDir;
process.env.APP_URL = "http://127.0.0.1:3000";
delete process.env.SMTP_URL;
delete process.env.STYLE_PUBLIC_DEPLOYMENT;
mkdirSync(dataDir, { recursive: true });
export const origin = process.env.APP_URL;
