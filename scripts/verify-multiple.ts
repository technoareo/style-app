import sharp from "sharp";
import { writeFile, mkdir } from "node:fs/promises";
import { analysisSchema } from "../src/domain/analysis";
async function main() {
  const shirt = await sharp("tests/fixtures/public-shirt.jpg")
    .resize(650, 650, { fit: "contain", background: "#fff" })
    .toBuffer();
  const hoodie = await sharp("tests/fixtures/public-hoodie.jpg")
    .resize(650, 650, { fit: "contain", background: "#fff" })
    .toBuffer();
  const photo = await sharp({
    create: { width: 1400, height: 750, channels: 3, background: "#fff" },
  })
    .composite([
      { input: shirt, left: 25, top: 50 },
      { input: hoodie, left: 725, top: 50 },
    ])
    .jpeg()
    .toBuffer();
  await writeFile("tests/fixtures/two-garments.jpg", photo);
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
      image: `data:image/jpeg;base64,${photo.toString("base64")}`,
    }),
  });
  const data = await response.json();
  await mkdir("docs/verification", { recursive: true });
  await writeFile(
    "docs/verification/multiple-vision.json",
    JSON.stringify(
      {
        status: response.status,
        seconds: (Date.now() - started) / 1000,
        ...data,
        image: undefined,
      },
      null,
      2,
    ),
  );
  if (!response.ok) throw new Error(data.error);
  const parsed = analysisSchema.parse(data);
  if (parsed.items.length !== 2)
    throw new Error(`Expected two garments, found ${parsed.items.length}`);
  if (
    !parsed.items.some((g) => g.category === "Tops") ||
    !parsed.items.some((g) => g.category === "Outerwear")
  )
    throw new Error("Wrong item categories");
  if (parsed.items.some((g) => g.brand || g.size))
    throw new Error("Unverified brand or size");
  console.log(
    `Live two-item extraction passed in ${(Date.now() - started) / 1000}s`,
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
