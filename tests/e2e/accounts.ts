import { test as base, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getReadyAuth } from "../../src/server/auth";
import { linkOf, waitForMail } from "../helpers/mailCapture";
export { expect };
export const test = base.extend<{ accountId: string }>({
  accountId: async ({}, use) => {
    // Disposable fixture accounts use the same auth implementation and private
    // development mail capture. User-facing sign-up is tested separately.
    const auth = await getReadyAuth();
    const email = `e2e-${randomUUID()}@example.test`;
    const result = await auth.api.signUpEmail({
      body: {
        name: "Test wearer",
        email,
        password: "Wardrobe test passphrase 42!",
      },
    });
    // Local mail capture is eventual (durable outbox): poll for it.
    const message = await waitForMail(
      process.env.STYLE_DATA_DIR || path.join(process.cwd(), ".data"),
      email,
      "Verify",
    );
    const url = linkOf(message);
    await auth.api.verifyEmail({
      query: { token: url.searchParams.get("token")! },
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
        url: "http://127.0.0.1:3000",
        httpOnly: true,
        sameSite: "Lax" as const,
      };
    });
    await context.addCookies(cookies);
    await use(context);
  },
});
