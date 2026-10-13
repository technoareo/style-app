import { getReadyAuth } from "../../src/server/auth";
import { getDatabase } from "../../src/server/database";

/**
 * Child process for tests/restoreCredentials.test.ts: a fresh Better Auth
 * instance on the (restored) data directory in STYLE_DATA_DIR, so the parent
 * can check sign-in and the self-service reset after the database file was
 * replaced underneath its own connections.
 *
 * Input (env PROBE, JSON):
 *   logins  [{ label, email, password }]   each is tried; result "ok" | "refused"
 *   resets  [{ label, email, newPassword }] request a reset (the token is read
 *           from the verification table, exactly what the emailed link carries),
 *           complete it, then sign in with the new password -> result "ok" | "refused"
 * Output: one JSON object { label: result } on stdout. Passwords are never printed.
 */
type Login = { label: string; email: string; password: string };
type Reset = { label: string; email: string; newPassword: string };

async function main(): Promise<void> {
  const probe = JSON.parse(process.env.PROBE ?? "{}") as {
    logins?: Login[];
    resets?: Reset[];
  };
  const auth = await getReadyAuth();
  const db = getDatabase();
  const out: Record<string, string> = {};
  const tryLogin = async (email: string, password: string) => {
    try {
      await auth.api.signInEmail({ body: { email, password } });
      return "ok";
    } catch {
      return "refused";
    }
  };
  for (const l of probe.logins ?? []) out[l.label] = await tryLogin(l.email, l.password);
  for (const r of probe.resets ?? []) {
    db.exec("DELETE FROM verification");
    await auth.api.requestPasswordReset({ body: { email: r.email } });
    const row = db
      .prepare(
        "SELECT identifier FROM verification WHERE identifier LIKE 'reset-password:%' ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { identifier: string } | undefined;
    if (!row) {
      out[r.label] = "no-token";
      continue;
    }
    const token = row.identifier.slice("reset-password:".length);
    await auth.api.resetPassword({ body: { newPassword: r.newPassword, token } });
    out[r.label] = await tryLogin(r.email, r.newPassword);
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

main().catch(() => {
  console.error("probe failed");
  process.exit(1);
});
