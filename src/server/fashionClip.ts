import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { Analysis } from "../domain/analysis";

export const FASHION_CLIP_MODEL = "Marqo/marqo-fashionCLIP";
export const FASHION_CLIP_REVISION = "44f4c655124ed71e90cbf528d82f508d69d8a81b";
type Candidate = { label: string; score: number };

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MODEL_TIMEOUT_MS = 120_000;
const MAX_CONCURRENT = Math.max(1, Math.min(2, Number(process.env.FASHION_MODEL_CONCURRENCY) || 1));
let activeRuns = 0;
const waiters: Array<() => void> = [];

const candidateSchema = z.object({ label: z.string().min(1).max(40), score: z.number().min(0).max(1) }).strict();
const pythonResultSchema = z.object({
  category: candidateSchema.refine((v) => Object.hasOwn(CATEGORY_MAP, v.label), "Unknown category"),
  pattern: candidateSchema.refine((v) => ["solid", "striped", "checked", "floral", "graphic", "polka dot", "animal print"].includes(v.label), "Unknown pattern"),
  material: candidateSchema.refine((v) => ["denim", "knit", "leather", "suede", "corduroy", "fleece", "satin", "lace", "sheer", "canvas", "mesh"].includes(v.label), "Unknown material"),
}).strict();

const CATEGORY_MAP: Record<string, Analysis["items"][number]["category"]> = {
  tops: "Tops", bottoms: "Bottoms", dresses: "Dresses", outerwear: "Outerwear",
  shoes: "Shoes", accessories: "Accessories",
};
const COLOR_NAMES: Array<[string, [number, number, number]]> = [
  ["black", [24, 23, 25]], ["white", [241, 239, 232]], ["grey", [128, 128, 128]],
  ["navy", [31, 48, 74]], ["blue", [45, 90, 160]], ["teal", [25, 130, 125]],
  ["green", [69, 122, 72]], ["olive", [113, 116, 62]], ["yellow", [225, 188, 58]],
  ["orange", [214, 117, 49]], ["red", [177, 54, 54]], ["burgundy", [102, 37, 50]],
  ["pink", [216, 133, 157]], ["purple", [111, 65, 131]], ["brown", [113, 75, 50]],
  ["beige", [201, 181, 145]],
];

const pythonPath = () => process.env.FASHION_MODEL_PYTHON?.trim() || "python";
const scriptPath = () => path.join(process.cwd(), "scripts", "fashion_clip_inference.py");
const modelPath = () => process.env.FASHION_MODEL_DIR?.trim() || path.join(process.cwd(), ".runtime", "fashionclip-model");

export function fashionClipCanStart(): boolean {
  const configured = process.env.FASHION_MODEL_PYTHON?.trim();
  return existsSync(scriptPath()) && existsSync(path.join(modelPath(), "open_clip_model.safetensors")) &&
    existsSync(path.join(modelPath(), "SHA256SUMS")) && (!configured || existsSync(configured));
}

export function topCandidate(output: Candidate[]): Candidate | null {
  return output.filter((entry) => typeof entry.label === "string" && Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score)[0] ?? null;
}

const distance = (a: [number, number, number], b: [number, number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Deterministic colour fallback; a licensed segmentation mask can later replace the border heuristic. */
export async function dominantColor(bytes: Buffer): Promise<string> {
  const { data, info } = await sharp(bytes).rotate().resize(64, 64, { fit: "inside", withoutEnlargement: false })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels: Array<[number, number, number]> = [];
  const border: Array<[number, number, number]> = [];
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const offset = (y * info.width + x) * info.channels;
    const pixel: [number, number, number] = [data[offset], data[offset + 1], data[offset + 2]];
    pixels.push(pixel);
    if (x < 3 || y < 3 || x >= info.width - 3 || y >= info.height - 3) border.push(pixel);
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 128;
  const background = [0, 1, 2].map((channel) => median(border.map((pixel) => pixel[channel]))) as [number, number, number];
  const foreground = pixels.filter((pixel) => {
    const light = (pixel[0] + pixel[1] + pixel[2]) / 3;
    return distance(pixel, background) > 42 && light > 18 && light < 244;
  });
  const sample = foreground.length >= Math.max(12, pixels.length * 0.04) ? foreground : pixels;
  const representative = [0, 1, 2].map((channel) => median(sample.map((pixel) => pixel[channel]))) as [number, number, number];
  return COLOR_NAMES.reduce((best, candidate) =>
    distance(representative, candidate[1]) < distance(representative, best[1]) ? candidate : best,
  )[0];
}

type PythonResult = { category: Candidate; pattern: Candidate; material: Candidate };

export async function validateFashionClipImage(bytes: Buffer): Promise<void> {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("FashionCLIP image size is not allowed");
  const metadata = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "error" }).metadata();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS)
    throw new Error("FashionCLIP image dimensions are not allowed");
  if (!new Set(["jpeg", "png", "webp", "heif", "avif"]).has(metadata.format ?? ""))
    throw new Error("FashionCLIP image format is not supported");
}

async function acquireSlot(): Promise<() => void> {
  if (activeRuns >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiters.push(resolve));
  activeRuns += 1;
  return () => { activeRuns -= 1; waiters.shift()?.(); };
}

export function fashionClipEnvironment(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {
    PYTHONUNBUFFERED: "1",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    FASHION_MODEL_DIR: modelPath(),
    FASHION_MODEL_REVISION: FASHION_CLIP_REVISION,
  };
  for (const key of process.platform === "win32" ? ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"] : ["PATH", "HOME", "TMPDIR"])
    if (source[key]) env[key] = source[key];
  return env;
}

export function parseFashionClipOutput(value: string): PythonResult {
  return pythonResultSchema.parse(JSON.parse(value));
}

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: false, windowsHide: true, stdio: "ignore" });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

async function runIsolatedModel(bytes: Buffer, signal?: AbortSignal): Promise<PythonResult> {
  await validateFashionClipImage(bytes);
  const release = await acquireSlot();
  if (signal?.aborted) { release(); throw new Error("FashionCLIP process aborted"); }
  try { return await new Promise((resolve, reject) => {
    const child = spawn(pythonPath(), [scriptPath()], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32", env: fashionClipEnvironment() as NodeJS.ProcessEnv,
    });
    const output: Buffer[] = [];
    let size = 0;
    let errorSize = 0;
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      terminateProcessTree(child);
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("FashionCLIP process timed out"), MODEL_TIMEOUT_MS);
    const abort = () => fail("FashionCLIP process aborted");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STDOUT_BYTES) fail("FashionCLIP output exceeded its limit"); else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorSize += chunk.length;
      if (errorSize > MAX_STDERR_BYTES) fail("FashionCLIP error output exceeded its limit");
    });
    child.once("error", () => fail("FashionCLIP process could not start"));
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (settled) return;
      settled = true;
      if (code !== 0 || size > MAX_STDOUT_BYTES || errorSize > MAX_STDERR_BYTES)
        return reject(new Error("FashionCLIP process failed"));
      try { resolve(parseFashionClipOutput(Buffer.concat(output).toString("utf8"))); }
      catch { reject(new Error("FashionCLIP returned invalid output")); }
    });
    child.stdin.end(bytes);
  }); } finally { release(); }
}

export async function analyzeWithFashionClip(bytes: Buffer, signal?: AbortSignal): Promise<Analysis> {
  const [result, color] = await Promise.all([runIsolatedModel(bytes, signal), dominantColor(bytes)]);
  const category = CATEGORY_MAP[result.category.label] ?? "Unsorted";
  const confidentCategory = result.category.score >= 0.42 && category !== "Unsorted";
  const confidentPattern = result.pattern.score >= 0.48;
  const confidentMaterial = result.material.score >= 0.52;
  const uncertain: NonNullable<Analysis["items"][number]["uncertain"]> = ["fit", "season", "occasion"];
  if (!confidentCategory) uncertain.push("category");
  if (!confidentPattern) uncertain.push("pattern");
  if (!confidentMaterial) uncertain.push("material");
  const resolvedCategory = confidentCategory ? category : "Unsorted";
  const names: Record<string, string> = { Tops: "Top", Bottoms: "Bottom", Dresses: "Dress", Outerwear: "Outerwear", Shoes: "Shoes", Accessories: "Accessory", Unsorted: "" };
  return {
    items: [{
      name: names[resolvedCategory], category: resolvedCategory, color,
      pattern: confidentPattern ? result.pattern.label : "",
      material: confidentMaterial ? result.material.label : "",
      fit: "unknown", seasons: [], occasions: [], formality: "unknown",
      brand: "", size: "", confidence: result.category.score, uncertain,
      evidence: "FashionCLIP suggested the category; colour was measured from image pixels",
      box: [0, 0, 1, 1],
    }],
    warning: "Local fashion recognition is experimental. Review every suggested detail before saving.",
    provenance: {
      provider: "fashionclip-local",
      model: FASHION_CLIP_MODEL,
      modelVersion: FASHION_CLIP_REVISION,
      fieldConfidence: {
        category: result.category.score,
        pattern: result.pattern.score,
        material: result.material.score,
      },
    },
  };
}
