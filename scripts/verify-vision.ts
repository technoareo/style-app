import { readFile, writeFile, mkdir } from "node:fs/promises";
import sharp from "sharp";
import { analysisSchema } from "../src/domain/analysis";
async function main() {
  const source = await readFile("tests/fixtures/public-shirt.jpg");
  const normalized = await sharp(source)
    .resize(1200, 1200, { fit: "inside" })
    .jpeg({ quality: 85 })
    .toBuffer();
  const started = Date.now();
  const response = await fetch("http://127.0.0.1:3000/api/analyze", {
    method: "POST",
    signal: AbortSignal.timeout(250000),
    headers: {
      origin: "http://127.0.0.1:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      consent: true,
      image: `data:image/jpeg;base64,${normalized.toString("base64")}`,
    }),
  });
  const result = await response.json();
  await mkdir("docs/verification", { recursive: true });
  await writeFile(
    "docs/verification/live-vision.json",
    JSON.stringify(
      {
        status: response.status,
        seconds: (Date.now() - started) / 1000,
        ...result,
        image: undefined,
      },
      null,
      2,
    ),
  );
  if (!response.ok) throw new Error(result.error);
  const parsed = analysisSchema.parse(result);
  if (
    parsed.items.length !== 1 ||
    parsed.items[0].category !== "Tops" ||
    !/white/i.test(parsed.items[0].color)
  )
    throw new Error("Single white T-shirt recognition failed");
  if (parsed.items[0].size)
    throw new Error("Model invented an unreadable size");
  console.log(
    `Live vision passed: ${parsed.items[0].name}, ${parsed.items[0].color}, ${(Date.now() - started) / 1000}s`,
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
