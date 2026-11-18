import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { Analysis } from "../domain/analysis";

export const FASHION_CLIP_MODEL = "Marqo/marqo-fashionCLIP";
type Candidate = { label: string; score: number };

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

export function fashionClipCanStart(): boolean {
  const configured = process.env.FASHION_MODEL_PYTHON?.trim();
  return existsSync(scriptPath()) && (!configured || existsSync(configured));
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

async function runIsolatedModel(bytes: Buffer): Promise<PythonResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(pythonPath(), [scriptPath()], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HF_HOME: process.env.FASHION_MODEL_CACHE || path.join(process.cwd(), ".runtime", "huggingface-python") },
    });
    const output: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) child.kill(); else output.push(chunk);
    });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || size > 64 * 1024) return reject(new Error("FashionCLIP process failed"));
      try { resolve(JSON.parse(Buffer.concat(output).toString("utf8"))); }
      catch { reject(new Error("FashionCLIP returned invalid output")); }
    });
    child.stdin.end(bytes);
  });
}

export async function analyzeWithFashionClip(bytes: Buffer): Promise<Analysis> {
  const [result, color] = await Promise.all([runIsolatedModel(bytes), dominantColor(bytes)]);
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
      evidence: `FashionCLIP category ${(result.category.score * 100).toFixed(0)}%; colour from pixels`,
      box: [0, 0, 1, 1],
    }],
    warning: "Local fashion recognition is experimental. Review every suggested detail before saving.",
  };
}
