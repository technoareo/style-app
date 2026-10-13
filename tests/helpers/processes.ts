import { execFile, fork, type ChildProcess } from "node:child_process";
import path from "node:path";

/**
 * Small helpers for the build 010 tests: run a repository script as a REAL
 * child process (`node --import tsx script args`) and fork a helper child with
 * an IPC channel. Nothing here is mocked.
 */

export type RunResult = { code: number; stdout: string; stderr: string };

export function runScript(
  script: string,
  args: string[],
  env: Record<string, string>,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", script, ...args],
      { cwd: process.cwd(), env: { ...process.env, ...env }, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error ? (error as { code?: unknown }).code : 0;
        if (typeof code !== "number") return reject(error);
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export type Helper = {
  proc: ChildProcess;
  messages: Record<string, unknown>[];
  stdout: () => string;
  stderr: () => string;
  /** Resolves with the next message that satisfies `match`. */
  next: (match: (m: Record<string, unknown>) => boolean, ms?: number) => Promise<Record<string, unknown>>;
  exited: Promise<number | null>;
};

export function forkHelper(file: string, env: Record<string, string>): Helper {
  const proc = fork(path.join(process.cwd(), file), [], {
    cwd: process.cwd(),
    execArgv: ["--import", "tsx"],
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const messages: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  let out = "";
  let err = "";
  proc.stdout?.on("data", (d: Buffer) => (out += d.toString()));
  proc.stderr?.on("data", (d: Buffer) => (err += d.toString()));
  proc.on("message", (m) => {
    messages.push(m as Record<string, unknown>);
    for (const w of waiters) w();
  });
  const exited = new Promise<number | null>((resolve) =>
    proc.on("close", (code) => {
      for (const w of waiters) w();
      resolve(code);
    }),
  );
  const next: Helper["next"] = (match, ms = 120_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error("Timed out waiting for a helper message."));
      }, ms);
      const check = () => {
        const found = messages.find(match);
        if (found) {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(found);
        } else if (proc.exitCode !== null) {
          clearTimeout(timer);
          waiters.delete(check);
          reject(new Error("The helper exited before the awaited message."));
        }
      };
      waiters.add(check);
      check();
    });
  return { proc, messages, stdout: () => out, stderr: () => err, next, exited };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
