import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { analyzeWithFashionClip, FASHION_CLIP_MODEL } from "../src/server/fashionClip";

const imagePath = process.argv[2];
if (!imagePath) throw new Error("Usage: npm run verify:fashionclip -- <rights-cleared-image>");

async function main() {
  const started = performance.now();
  const analysis = await analyzeWithFashionClip(await readFile(resolve(imagePath)));
  process.stdout.write(`${JSON.stringify({
    model: FASHION_CLIP_MODEL,
    elapsedMs: Math.round(performance.now() - started),
    analysis,
  }, null, 2)}\n`);
}

void main();
