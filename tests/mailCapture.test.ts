import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { linkOf, waitForMail } from "./helpers/mailCapture";

/**
 * Local development capture still works, but it now goes THROUGH the durable
 * outbox: a sign-up enqueues, the web process drains its own queue into the
 * private `mail-outbox` folder a moment later (eventual), and the outbox row
 * ends as "sent" with its address and body cleared.
 */

const dataDir = path.join(process.cwd(), ".data", "tests", randomUUID());
mkdirSync(dataDir, { recursive: true });
process.env.STYLE_DATA_DIR = dataDir;
process.env.APP_URL = "http://127.0.0.1:3000";
delete process.env.SMTP_URL;
delete process.env.STYLE_PUBLIC_DEPLOYMENT;

after(async () => {
  (await import("../src/server/database")).closeDatabases();
});

test("development capture is eventual, private, and flows through the outbox", async () => {
  const { getReadyAuth } = await import("../src/server/auth");
  const { getDatabase } = await import("../src/server/database");
  const auth = await getReadyAuth();
  const email = `capture-${randomUUID()}@example.test`;
  const created = await auth.api.signUpEmail({
    body: { email, name: "Capture", password: "Capture test passphrase 88!" },
  });
  const message = await waitForMail(dataDir, email, "Verify");
  assert.match(linkOf(message).searchParams.get("token") ?? "", /\S+/);
  assert.equal(message.to, email);

  const db = getDatabase();
  const deadline = Date.now() + 10_000;
  let row: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    row = db
      .prepare("SELECT * FROM mail_outbox WHERE user_id=?")
      .get(created.user.id) as Record<string, unknown> | undefined;
    if (row?.status === "sent") break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(row?.status, "sent");
  assert.equal(row?.to_address, null);
  assert.equal(row?.text_body, null);
});
