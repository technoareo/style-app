import { test as base, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { getReadyAuth } from "../../src/server/auth";
import { runWriteTransaction } from "../../src/server/writeTransaction";
export { expect };

const testPort = process.env.PLAYWRIGHT_PORT ?? "3000";
const testOrigin = `http://127.0.0.1:${testPort}`;

export const test = base.extend<{ accountId: string }>({
  accountId: async ({}, use) => {
    // Browser journeys exercise authenticated product behaviour, not mail
    // delivery. Temporarily configure a relay so sign-up still writes the real
    // durable outbox row without starting the development capture drain. The
    // dedicated auth/mail suites cover verification links and capture.
    const auth = await getReadyAuth();
    const email = `e2e-${randomUUID()}@example.test`;
    const previousSmtp = process.env.SMTP_URL;
    process.env.SMTP_URL = "smtp://127.0.0.1:1";
    let result: Awaited<ReturnType<typeof auth.api.signUpEmail>>;
    try {
      result = await auth.api.signUpEmail({
        body: {
          name: "Test wearer",
          email,
          password: "Wardrobe test passphrase 42!",
        },
      });
    } finally {
      if (previousSmtp === undefined) delete process.env.SMTP_URL;
      else process.env.SMTP_URL = previousSmtp;
    }
    await runWriteTransaction((db) => {
      db.prepare('UPDATE "user" SET "emailVerified"=1 WHERE id=?').run(
        result.user.id,
      );
      db.prepare(
        "UPDATE mail_outbox SET status='cancelled', to_address=NULL, subject=NULL, text_body=NULL, html_body=NULL, lease_until=NULL WHERE user_id=? AND status='queued'",
      ).run(result.user.id);
    });
    await use(JSON.stringify({ id: result.user.id, email }));
  },
  context: async ({ context, accountId }, use) => {
    const auth = await getReadyAuth();
    const user = JSON.parse(accountId);
    const response = await auth.api.signInEmail({
      body: { email: user.email, password: "Wardrobe test passphrase 42!" },
      asResponse: true,
    });
    const cookies = response.headers.getSetCookie().map((cookie) => {
      const [pair] = cookie.split(";");
      const index = pair.indexOf("=");
      return {
        name: pair.slice(0, index),
        value: pair.slice(index + 1),
        url: testOrigin,
        httpOnly: true,
        sameSite: "Lax" as const,
      };
    });
    await context.addCookies(cookies);
    await use(context);
  },
});
