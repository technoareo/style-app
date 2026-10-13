import { visionOutputSchema, VISION_PROMPT } from "../src/domain/analysis";
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
async function main() {
  const b = await sharp("tests/fixtures/two-garments.jpg")
    .resize(512, 512, { fit: "inside" })
    .jpeg()
    .toBuffer();
  const r = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "qwen3-vl:2b-instruct",
      think: false,
      stream: false,
      format: visionOutputSchema,
      options: { temperature: 0, num_predict: 1000, num_ctx: 4096 },
      messages: [
        {
          role: "user",
          images: [b.toString("base64")],
          content: VISION_PROMPT,
        },
      ],
    }),
  });
  const result = await r.json();
  await writeFile(
    "docs/verification/debug-model.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
}
main();

