import { randomUUID } from "node:crypto";
import path from "node:path";
import { getReadyAuth } from "../src/server/auth";
import { waitForMail } from "../tests/helpers/mailCapture";
/**
 * A brand-new disposable account (unique random e-mail and password every call, never reused and never written
 * to evidence). `appOrigin` is where the browser will present the session cookie; it defaults to local port 3000.
 */
export async function verificationAccount(appOrigin = "http://127.0.0.1:3000") {
  if (process.env.STYLE_PUBLIC_DEPLOYMENT === "true" || process.env.SMTP_URL)
    throw new Error(
      "Verification fixtures require local development mail capture.",
    );
  const auth = await getReadyAuth(),
    email = `vision-${randomUUID()}@example.test`,
    password = randomUUID() + randomUUID();
  const signup = await auth.api.signUpEmail({
    body: { name: "Vision test wearer", email, password },
  });
  // Local mail capture is eventual (durable outbox): poll for it.
  const mail = await waitForMail(
    process.env.STYLE_DATA_DIR || path.join(process.cwd(), ".data"),
    email,
    "Verify",
  );
  const url = new URL(mail.text.split(": ").slice(1).join(": "));
  await auth.api.verifyEmail({
    query: { token: url.searchParams.get("token")! },
  });
  const response = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  return {
    id: signup.user.id,
    cookies: response.headers.getSetCookie().map((c) => {
      const pair = c.split(";")[0],
        index = pair.indexOf("=");
      return {
        name: pair.slice(0, index),
        value: pair.slice(index + 1),
        url: appOrigin,
        httpOnly: true,
        secure: appOrigin.startsWith("https:"),
        sameSite: "Lax" as const,
      };
    }),
  };
}
