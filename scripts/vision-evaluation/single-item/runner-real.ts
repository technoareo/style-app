import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { EvaluationRefusal } from "../evaluate";
import type { RunIdentity, RunnerDeps } from "./runner";

/**
 * Maps the app VisionError kinds exactly to run outcomes. Matching is by instanceof of the class the caller
 * passes (the real VisionError), never by name or by a look-alike object. "unreadable" and anything else is
 * not a model outcome: null, which the runner records as an unexpected runner error.
 */
export function makeClassify(VisionErrorClass: new (...args: never[]) => Error & { kind: string }): RunnerDeps["classify"] {
  return (error) => {
    if (!(error instanceof VisionErrorClass)) return null;
    const kind = (error as { kind: string }).kind;
    if (kind === "timeout" || kind === "unavailable" || kind === "unverified") return { outcome: kind, message: error.message };
    return null;
  };
}

/**
 * The real dependencies of the benchmark runner: the app's own modules. Loaded lazily so tests and the
 * other commands never pull in the image library or the model client. There is no recognizer here; every
 * call goes to src/server/vision.ts.
 */

function gitState(cwd: string): { commit: string; dirty: boolean } {
  const run = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    return { commit: run(["rev-parse", "HEAD"]).trim(), dirty: run(["status", "--porcelain"]).trim().length > 0 };
  } catch {
    return { commit: "unknown", dirty: true };
  }
}

export async function realRunnerDeps(log: (line: string) => void, cwd = process.cwd()): Promise<RunnerDeps> {
  // The same environment files the app and the analysis worker read (VISION_MODEL, OLLAMA_URL, timeouts).
  const { loadLocalEnvFiles } = await import("../../../src/server/localEnv");
  loadLocalEnvFiles({ dir: cwd });
  const vision = await import("../../../src/server/vision");
  const { limits } = await import("../../../src/server/limits");

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());

  const identity = async (): Promise<RunIdentity> => {
    const model = vision.configuredVisionModel();
    if (!model.ok) throw new EvaluationRefusal(["VISION_MODEL is not a valid model name; the app would refuse every analysis"]);
    const request = vision.visionRequestIdentity("single");
    // The runtime's own digest of the installed model: the honest "version" of a local model.
    let tags: { models?: Array<{ name: string; digest?: string }> };
    try {
      const response = await fetch(`${vision.ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
      if (!response.ok) throw new Error("tags");
      tags = (await response.json()) as typeof tags;
    } catch {
      throw new EvaluationRefusal(["Ollama is not reachable, so the model version cannot be determined; no run is started"]);
    }
    const wanted = model.name.includes(":") ? model.name : `${model.name}:latest`;
    const found = tags.models?.find((m) => m.name === model.name || m.name === wanted);
    if (!found || typeof found.digest !== "string" || found.digest.length < 12) throw new EvaluationRefusal([`the configured model "${model.name}" is not installed in Ollama (or reports no digest)`]);
    return { model: model.name, modelVersion: `ollama-digest:${found.digest}`, promptSha256: request.promptSha256, requestSha256: request.requestSha256, timeoutMs: limits().inferenceTimeoutMs };
  };

  return {
    analyze: (normalized, signal, options) => vision.analyzePhoto(normalized, signal, options),
    normalize: (bytes) => vision.normalizePhoto(bytes),
    classify: makeClassify(vision.VisionError),
    identity,
    git: () => gitState(cwd),
    now: () => new Date(),
    monotonicMs: () => performance.now(),
    readFile: (file) => readFileSync(file),
    log,
    signal: controller.signal,
  };
}
