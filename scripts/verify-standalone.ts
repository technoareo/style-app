/**
 * Strongest packaging check: starts the built standalone bundle in ISOLATION
 * and exercises real routes.
 *
 *   npm run build && npm run verify:standalone
 *
 * Isolation, so a missing runtime dependency cannot be masked:
 *  - the bundle is copied to a fresh folder directly under the OS temp
 *    directory, so Node's module resolution has NO ancestor node_modules to
 *    fall back to (inside the project it would silently find
 *    style-app/node_modules and hide anything the bundle lacks);
 *  - links are copied verbatim (never re-pointed back at the project);
 *  - NODE_PATH, NODE_OPTIONS and every STYLE_*, APP_URL, AUTH_SECRET, SMTP_URL,
 *    MAIL_FROM and OLLAMA_URL variable are removed from the child environment;
 *  - it gets its own empty data directory, so the project's real `.data` is
 *    never opened, and a throwaway account on a loopback port.
 *
 * Routes exercised: health (database, Better Auth, Kysely, migrations), sign-up
 * (password hashing, the mail outbox and local capture, nodemailer), email
 * verification, sign-in, an authenticated wardrobe read, the analysis status and
 * job lists, and a photo upload and download (sharp's native binary). No model,
 * no network beyond loopback, no real email, no real account.
 *
 * The only deletion is of the folder this script created itself, performed
 * with the link-safe remover and only after proving it is a direct child of
 * the real OS temp directory with this script's prefix.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectPackagingProblems } from "./packaging-rules";
import { removeGenerated } from "./packaging-sanitize";

const PREFIX = "style-standalone-";
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

class Check extends Error {}
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Check(message);
}

async function main(): Promise<void> {
  const root = process.cwd();
  const problems = collectPackagingProblems(root);
  if (problems.length)
    throw new Check(`Packaging check failed first: ${problems[0]}`);

  const tmpReal = realpathSync(tmpdir());
  const work = mkdtempSync(path.join(tmpReal, PREFIX));
  const workReal = realpathSync(work);
  if (
    path.dirname(workReal) !== tmpReal ||
    !path.basename(workReal).startsWith(PREFIX)
  )
    throw new Check("Refusing to use an unexpected temporary folder.");
  const app = path.join(workReal, "app");
  const data = path.join(workReal, "data");
  let child: ChildProcess | null = null;
  let log = "";
  try {
    const source = path.join(realpathSync(root), ".next", "standalone");
    cpSync(source, app, { recursive: true, verbatimSymlinks: true });
    const stat = path.join(realpathSync(root), ".next", "static");
    if (existsSync(stat))
      cpSync(stat, path.join(app, ".next", "static"), {
        recursive: true,
        verbatimSymlinks: true,
      });
    const publicDir = path.join(realpathSync(root), "public");
    if (existsSync(publicDir))
      cpSync(publicDir, path.join(app, "public"), {
        recursive: true,
        verbatimSymlinks: true,
      });
    mkdirSync(data, { recursive: true, mode: 0o700 });

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const inherited: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (
        /^(NODE_PATH|NODE_OPTIONS|APP_URL|AUTH_SECRET|SMTP_URL|MAIL_FROM|OLLAMA_URL|STYLE_.*)$/.test(
          key,
        )
      )
        continue;
      inherited[key] = value;
    }
    // Next's type augmentation makes NODE_ENV a required ProcessEnv key, so
    // it is set in the same literal that builds the environment.
    const env: NodeJS.ProcessEnv = {
      ...inherited,
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      APP_URL: base,
      STYLE_DATA_DIR: data,
      NEXT_TELEMETRY_DISABLED: "1",
    };
    child = spawn(process.execPath, [path.join(app, "server.js")], {
      cwd: app,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });
    const keep = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-4000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);

    const call = (route: string, init: RequestInit = {}) =>
      fetch(base + route, {
        redirect: "manual",
        ...init,
        headers: { origin: base, ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(60_000),
      });

    // 1. Boot and health.
    const bootDeadline = Date.now() + 120_000;
    for (;;) {
      if (exited) throw new Check("The standalone server exited during start-up.");
      try {
        const health = await call("/api/health");
        if (health.status === 200) {
          expect(
            (await health.json()).ready === true,
            "health did not report ready",
          );
          break;
        }
      } catch {
        // not listening yet
      }
      if (Date.now() > bootDeadline)
        throw new Check("The standalone server did not become healthy in time.");
      await sleep(500);
    }

    // 2. Sign up, find the captured mail, verify, sign in.
    const email = `standalone-${Date.now()}@example.test`;
    const password = "Standalone check passphrase 21!";
    const signUp = await call("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, name: "Standalone", callbackURL: "/" }),
    });
    expect(signUp.status === 200, `sign-up returned ${signUp.status}`);
    let link = "";
    const mailDeadline = Date.now() + 30_000;
    while (!link) {
      const dir = path.join(data, "mail-outbox");
      if (existsSync(dir))
        for (const file of readdirSync(dir)) {
          try {
            const mail = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
            if (mail.to === email) link = String(mail.text).split(": ").slice(1).join(": ");
          } catch {
            // half-written; next poll
          }
        }
      if (link) break;
      if (Date.now() > mailDeadline)
        throw new Check("The verification mail was not captured (outbox or nodemailer missing?).");
      await sleep(200);
    }
    const verified = await call(new URL(link).pathname + new URL(link).search);
    expect(verified.status < 400, `verification returned ${verified.status}`);
    const signIn = await call("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(signIn.status === 200, `sign-in returned ${signIn.status}`);
    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const userId = (await signIn.json()).user?.id as string;
    expect(cookie && userId, "sign-in did not return a session");
    const authed = { cookie, "x-style-account": userId };

    // 3. Routes behind the session.
    expect((await call("/api/wardrobe")).status === 401, "wardrobe must refuse anonymous callers");
    const wardrobe = await call("/api/wardrobe", { headers: authed });
    expect(wardrobe.status === 200, `wardrobe returned ${wardrobe.status}`);
    expect((await wardrobe.json()).revision === 0, "new account should start at revision 0");
    const analyze = await call("/api/analyze", { headers: authed });
    expect(analyze.status === 200, `analyze status returned ${analyze.status}`);
    const jobs = await call("/api/analysis-jobs", { headers: authed });
    expect(jobs.status === 200, `analysis-jobs returned ${jobs.status}`);

    // 4. Photo upload and download (sharp's native binary).
    const upload = await call("/api/photos", {
      method: "POST",
      headers: { ...authed, "content-type": "application/json" },
      body: JSON.stringify({ image: `data:image/png;base64,${PNG_1X1}` }),
    });
    expect(upload.status === 200, `photo upload returned ${upload.status} (sharp missing?)`);
    const uploaded = (await upload.json()) as { image: string };
    expect(/^\/api\/photos\/[\w-]+$/.test(uploaded.image), "unexpected photo id");
    const photo = await call(uploaded.image, { headers: authed });
    expect(photo.status === 200, `photo download returned ${photo.status}`);
    expect(
      photo.headers.get("content-type") === "image/jpeg",
      "photo was not returned as JPEG",
    );

    // 5. The home page renders.
    const home = await call("/");
    expect(home.status === 200, `home page returned ${home.status}`);

    console.log(
      "Standalone check passed: the bundle started and served real routes from an isolated copy with no ancestor node_modules.",
    );
  } catch (error) {
    if (log && !(error instanceof Check && /packaging/i.test(error.message)))
      console.error("Last server output:\n" + log);
    throw error;
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
    }
    // Remove only what this script created, with the link-safe remover.
    for (const attempt of [1, 2, 3, 4, 5]) {
      try {
        for (const dir of [app, data])
          if (existsSync(dir)) removeGenerated(workReal, dir);
        rmdirSync(workReal);
        break;
      } catch {
        if (attempt === 5)
          console.error(`Could not remove the temporary folder ${workReal}; remove it by hand.`);
        await sleep(300);
      }
    }
  }
}

main().catch((error) => {
  console.error(
    "Standalone check FAILED:",
    error instanceof Error ? error.message : "unexpected error",
  );
  process.exit(1);
});
