import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validatePassphrase } from "../src/server/backupPassphrase";
import {
  PASSPHRASE_FILE,
  STYLE_UID,
  WRONG_PASSPHRASE_FILE,
  appRunArgs,
  cliRunArgs,
  copyInArgs,
  copyOutArgs,
  createVolumeArgs,
  drillNames,
  findSecret,
  generatePassphrase,
  inspectExecArgs,
  inspectRunArgs,
  listByLabelArgs,
  makeRunId,
  redact,
  writeSecretArgs,
  type InspectEnv,
  type Names,
} from "./ci-backup-drill-plan";

/**
 * Build 022: the encrypted backup TRANSFER and FRESH RESTORE drill that GitHub's
 * Ubuntu/Docker job runs against the REAL built image.
 *
 *   npx tsx scripts/ci-backup-drill.ts                 run the drill
 *   npx tsx scripts/ci-backup-drill.ts --cleanup-only  remove anything a drill left (by label)
 *
 *   IMAGE (default style-studio:ci)   DRILL_PORT (default 3100)
 *
 * What happens, in order (each is a hard check; the first failure stops the
 * drill, cleans up and exits 1):
 *  1. A strong random passphrase (and an unrelated wrong one) exist only in this
 *     process. They go to a dedicated SECRETS volume through stdin: owner uid
 *     1001, mode 0400. They are in no argument, no environment, no log.
 *  2. The real image runs as the app on a SOURCE volume. Through its real HTTP
 *     routes the drill seeds: a kept account with a photo and a wardrobe, a
 *     second account that is then deleted, a live session, a password-reset
 *     token, captured mail, a queued temporary analysis photo and rate-limit
 *     rows. A precondition check proves every one of those exists.
 *  3. The real `backup-encrypted` command runs in its own container against the
 *     live source volume. The package must be the only artifact, mode 0600 in a
 *     0700 exports directory, owned by uid 1001, with no plain backup left.
 *  4. The package is copied OUT to a host folder and INTO a different, empty
 *     FRESH volume (and into a NEGATIVE volume): the artifact transfer.
 *     The source app is then stopped.
 *  5. Negative cases on the empty NEGATIVE volume: a wrong passphrase, a
 *     tampered package and a truncated package all fail with their fixed codes
 *     and leave no app.db, no staging and no partial file.
 *  6. The real `restore-encrypted` command restores onto the FRESH volume. The
 *     kept account, photo and wardrobe match the source byte for byte (by
 *     hash); the deleted account is absent and recorded as deleted; sessions,
 *     reset tokens, queued mail, mail captures, analysis jobs and rate-limit
 *     rows are all gone; every credential password is invalidated.
 *  7. The real image starts on the restored volume and answers /api/health.
 *     The old password and the deleted account are refused; a reset works.
 *  8. With that app stopped, a wrong passphrase against the now-LIVE restored
 *     database fails and app.db is byte-identical before and after.
 *  Finally every container, volume and host file this run made is removed, in a
 *  `finally`, and the run fails if any labelled resource remains.
 *
 * Nothing here downloads a model: the drill never starts an AI worker and never
 * calls the model. The passphrases are redacted from everything printed and the
 * drill fails if either one appears in any captured command output or argument.
 */

export type DockerResult = { code: number; stdout: string; stderr: string };
export type DockerOptions = { input?: string; timeoutMs?: number; allowFail?: boolean };
export type Docker = (args: string[], options?: DockerOptions) => Promise<DockerResult>;

export type DrillDeps = {
  docker: Docker;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  random?: (n: number) => Buffer;
  image?: string;
  port?: number;
  hostUid?: number;
  hostGid?: number;
  /** Where the drill's host folder lives (default: the OS temp folder). */
  tmpRoot?: string;
  inspectHostPath?: string;
};

export type DrillContext = {
  deps: DrillDeps;
  names: Names;
  image: string;
  port: number;
  base: string;
  hostDir: string;
  inspectHostPath: string;
  secrets: string[];
  passphrase: string;
  wrongPassphrase: string;
  argvLog: string[][];
  outputs: string[];
  containers: string[];
  step: (label: string) => void;
  docker: Docker;
};

export type Scenario = (ctx: DrillContext) => Promise<void>;

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function realDocker(): Docker {
  return (args, options = {}) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        "docker",
        args,
        { timeout: options.timeoutMs ?? 240_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          const code = error ? (error as { code?: unknown }).code : 0;
          if (typeof code !== "number") return reject(new Error("The docker command could not run."));
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
      if (options.input !== undefined) child.stdin?.end(options.input);
    });
}

/** Run the drill; always clean up; throw the first failure (after cleanup). */
export async function runDrill(deps: DrillDeps, scenario: Scenario = realScenario): Promise<void> {
  const random = deps.random ?? undefined;
  const names = drillNames(makeRunId(random));
  const passphrase = generatePassphrase(random);
  const wrongPassphrase = generatePassphrase(random);
  validatePassphrase(passphrase);
  validatePassphrase(wrongPassphrase);
  expect(passphrase !== wrongPassphrase, "The two passphrases must differ.");
  const log = deps.log ?? ((line: string) => console.log(line));
  const secrets = [passphrase, wrongPassphrase];
  const hostDir = mkdtempSync(path.join(deps.tmpRoot ?? os.tmpdir(), "style-drill-"));
  chmodSync(hostDir, 0o700);
  const argvLog: string[][] = [];
  const outputs: string[] = [];
  let currentStep = "start";
  const ctx: DrillContext = {
    deps,
    names,
    image: deps.image ?? "style-studio:ci",
    port: deps.port ?? 3100,
    base: `http://127.0.0.1:${deps.port ?? 3100}`,
    hostDir,
    inspectHostPath:
      deps.inspectHostPath ?? path.join(process.cwd(), "scripts", "ci-backup-drill-inspect.ts"),
    secrets,
    passphrase,
    wrongPassphrase,
    argvLog,
    outputs,
    containers: [],
    step: (label) => {
      currentStep = label;
      log(`[drill ${names.runId}] ${label}`);
    },
    docker: async (args, options = {}) => {
      argvLog.push(args);
      const result = await deps.docker(args, options);
      outputs.push(result.stdout, result.stderr);
      if (result.code !== 0 && !options.allowFail)
        throw new Error(
          `docker ${args[0]} failed during "${currentStep}" (exit ${result.code}): ${redact(result.stderr, secrets).trim().slice(-400)}`,
        );
      return result;
    },
  };

  let failure: unknown;
  try {
    await scenario(ctx);
    // Anything the passphrases touched must not appear in any argument or output.
    const leaked = findSecret(secrets, [...argvLog.map((a) => a.join(" ")), ...outputs]);
    expect(leaked === undefined, "A passphrase appeared in a docker argument or output.");
  } catch (error) {
    failure = error;
    await explain(ctx).catch(() => undefined);
  }
  try {
    await cleanup(ctx);
  } catch (error) {
    failure ??= error;
    log(`[drill ${names.runId}] CLEANUP FAILED: ${redact(String((error as Error).message), secrets)}`);
  }
  if (failure)
    throw new Error(redact(failure instanceof Error ? failure.message : "The drill failed.", secrets));
  log(`[drill ${names.runId}] PASSED and cleaned up.`);
}

/** On failure, show the tail of the app logs (the app logs no secrets, tokens or bodies), redacted. */
async function explain(ctx: DrillContext): Promise<void> {
  for (const name of ctx.containers) {
    const r = await ctx.deps.docker(["logs", "--tail", "40", name]);
    const text = redact(`${r.stdout}${r.stderr}`, ctx.secrets).trim();
    if (text) (ctx.deps.log ?? console.log)(`--- ${name} (last lines) ---\n${text}`);
  }
}

async function cleanup(ctx: DrillContext): Promise<void> {
  const { docker } = ctx.deps;
  const runId = ctx.names.runId;
  // Containers first (they hold the volumes), then volumes, then host files.
  for (const name of new Set([ctx.names.sourceApp, ctx.names.restoredApp, ...ctx.containers]))
    await docker(["rm", "-f", "-v", name]);
  const containers = (await docker(listByLabelArgs("container", runId))).stdout.split(/\s+/).filter(Boolean);
  for (const id of containers) await docker(["rm", "-f", "-v", id]);
  for (const volume of Object.values(ctx.names.volumes)) await docker(["volume", "rm", "-f", volume]);
  const volumes = (await docker(listByLabelArgs("volume", runId))).stdout.split(/\s+/).filter(Boolean);
  for (const volume of volumes) await docker(["volume", "rm", "-f", volume]);
  rmSync(ctx.hostDir, { recursive: true, force: true });
  const leftContainers = (await docker(listByLabelArgs("container", runId))).stdout.trim();
  const leftVolumes = (await docker(listByLabelArgs("volume", runId))).stdout.trim();
  expect(!leftContainers && !leftVolumes, "Drill containers or volumes remain after cleanup.");
}

/** `--cleanup-only`: remove everything any drill run labelled (for an `if: always()` workflow step). */
export async function cleanupAll(docker: Docker, log: (line: string) => void = console.log): Promise<number> {
  let removed = 0;
  for (const id of (await docker(listByLabelArgs("container"))).stdout.split(/\s+/).filter(Boolean)) {
    await docker(["rm", "-f", "-v", id]);
    removed++;
  }
  for (const volume of (await docker(listByLabelArgs("volume"))).stdout.split(/\s+/).filter(Boolean)) {
    await docker(["volume", "rm", "-f", volume]);
    removed++;
  }
  log(`Drill cleanup removed ${removed} leftover resource(s).`);
  return removed;
}

// --- the real scenario ---------------------------------------------------------

type Facts = {
  dbExists: boolean;
  dbOwnerUid: number | null;
  dbSha256: string | null;
  exportsDirMode: string | null;
  packages: { name: string; mode: string; uid: number }[];
  partials: number;
  plainBackups: number;
  stagingEntries: number;
  pendingFiles: number;
  mailCaptureFiles: number;
  secretFile: { mode: string; uid: number } | null;
  db: null | {
    keptUserPresent: boolean;
    deletedUserPresent: boolean;
    deletedUserRecorded: boolean;
    deletedUserRows: number;
    photoCount: number;
    photoHash: string | null;
    wardrobeRevision: number | null;
    wardrobeHash: string | null;
    sessions: number;
    verifications: number;
    mailOutbox: number;
    analysisJobs: number;
    rateLimitRows: number;
    credentialPasswords: number;
    integrity: string;
  };
};

const lastJson = <T>(text: string): T => JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as T;

async function realScenario(ctx: DrillContext): Promise<void> {
  const { names, image } = ctx;
  const runId = names.runId;
  const doFetch = ctx.deps.fetchImpl ?? fetch;
  const hostUid = ctx.deps.hostUid ?? process.getuid?.() ?? STYLE_UID;
  const hostGid = ctx.deps.hostGid ?? process.getgid?.() ?? STYLE_UID;
  const identity: { keptId: string; deletedId: string } = { keptId: "", deletedId: "" };
  const emails = {
    kept: `drill-kept-${runId}@example.test`,
    deleted: `drill-deleted-${runId}@example.test`,
  };
  const password = `Drill seeded passphrase ${runId} 41!`;
  const resetPassword = `Drill reset passphrase ${runId} 52!`;

  const idEnv = (): InspectEnv => ({ KEPT_ID: identity.keptId, DELETED_ID: identity.deletedId });
  const factsRun = async (volume: string, extra: InspectEnv = {}, withSecret = false): Promise<Facts> =>
    lastJson<Facts>(
      (
        await ctx.docker(
          inspectRunArgs({
            image,
            runId,
            volume,
            inspectHostPath: ctx.inspectHostPath,
            mode: "facts",
            env: { ...idEnv(), ...extra },
            secretsVolume: withSecret ? names.volumes.secrets : undefined,
          }),
        )
      ).stdout,
    );
  const factsExec = async (container: string, extra: InspectEnv = {}): Promise<Facts> =>
    lastJson<Facts>(
      (await ctx.docker(inspectExecArgs({ container, mode: "facts", env: { ...idEnv(), ...extra } }))).stdout,
    );
  const mailLink = async (container: string, to: string, fragment: string): Promise<URL> => {
    const out = lastJson<{ link: string }>(
      (await ctx.docker(inspectExecArgs({ container, mode: "mail", env: { MAIL_TO: to, MAIL_TEXT: fragment } })))
        .stdout,
    );
    return new URL(out.link);
  };
  const call = (route: string, init: RequestInit = {}) =>
    doFetch(ctx.base + route, {
      redirect: "manual",
      ...init,
      headers: { origin: ctx.base, ...(init.headers as Record<string, string>) },
      signal: AbortSignal.timeout(60_000),
    });
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    call(route, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const waitHealthy = async () => {
    const end = Date.now() + 90_000;
    for (;;) {
      try {
        if ((await call("/api/health")).status === 200) return;
      } catch {
        // not listening yet
      }
      expect(Date.now() < end, "The app did not become healthy in time.");
      await sleep(1000);
    }
  };
  const signIn = async (email: string, pass: string) => {
    const r = await post("/api/auth/sign-in/email", { email, password: pass });
    const cookie = r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const id = r.status === 200 ? (((await r.json()) as { user?: { id?: string } }).user?.id ?? "") : "";
    return { status: r.status, cookie, id };
  };
  const startApp = async (name: string, volume: string) => {
    ctx.containers.push(name);
    await ctx.docker(
      appRunArgs({ image, runId, name, volume, port: ctx.port, inspectHostPath: ctx.inspectHostPath }),
    );
    await waitHealthy();
  };
  const hostPackage = (fileName: string) => path.join(ctx.hostDir, fileName);

  // 1. Volumes and the separately held passphrases ------------------------------
  ctx.step("create isolated volumes and write the passphrases to the secrets volume");
  for (const volume of Object.values(names.volumes))
    await ctx.docker(createVolumeArgs(runId, volume));
  await ctx.docker(writeSecretArgs(image, runId, names.volumes.secrets, "backup-passphrase"), {
    input: ctx.passphrase,
  });
  await ctx.docker(writeSecretArgs(image, runId, names.volumes.secrets, "wrong-passphrase"), {
    input: ctx.wrongPassphrase,
  });
  for (const file of [PASSPHRASE_FILE, WRONG_PASSPHRASE_FILE]) {
    const f = await factsRun(names.volumes.negative, { SECRET_FILE: file }, true);
    expect(f.secretFile?.mode === "400", "The secret file must be mode 0400.");
    expect(f.secretFile?.uid === STYLE_UID, "The secret file must be owned by the image user.");
  }

  // 2. Seed the SOURCE volume through the real app ------------------------------
  ctx.step("start the real image as the app on the source volume");
  await startApp(names.sourceApp, names.volumes.source);

  ctx.step("seed accounts, photo, wardrobe, session, reset token, mail, analysis photo");
  for (const email of Object.values(emails)) {
    const r = await post("/api/auth/sign-up/email", {
      email,
      password,
      name: "Drill account",
      callbackURL: "/",
    });
    expect(r.status === 200, `sign-up returned ${r.status}`);
    const link = await mailLink(names.sourceApp, email, "Confirm your email");
    const verified = await call(link.pathname + link.search);
    expect(verified.status < 400, `verification returned ${verified.status}`);
  }
  const kept = await signIn(emails.kept, password);
  const deleted = await signIn(emails.deleted, password);
  expect(kept.status === 200 && kept.id && deleted.status === 200 && deleted.id, "seed sign-in failed");
  identity.keptId = kept.id;
  identity.deletedId = deleted.id;
  const authed = { cookie: kept.cookie, "x-style-account": kept.id };

  const sharp = (await import("sharp")).default;
  const jpeg = await sharp({
    create: { width: 320, height: 320, channels: 3, background: "#3366aa" },
  })
    .jpeg()
    .toBuffer();
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  const photo = await post("/api/photos", { image: dataUrl }, authed);
  expect(photo.status === 200, `photo upload returned ${photo.status}`);
  const photoPath = ((await photo.json()) as { image: string }).image;
  const current = (await (await call("/api/wardrobe", { headers: authed })).json()) as Record<string, unknown>;
  const saved = await call("/api/wardrobe", {
    method: "PUT",
    headers: { ...authed, "content-type": "application/json" },
    body: JSON.stringify({
      ...current,
      name: "Drill wardrobe",
      wardrobe: [
        {
          id: "drill-tee",
          name: "Drill marker tee",
          category: "Tops",
          color: "blue",
          brand: "",
          size: "",
          image: photoPath,
          reviewed: true,
        },
      ],
      looks: [],
    }),
  });
  expect(saved.status === 200, `wardrobe save returned ${saved.status}`);
  const job = await post("/api/analyze", { image: dataUrl, consent: true }, authed);
  expect(job.status === 202, `analysis submit returned ${job.status}`);
  const reset = await post("/api/auth/request-password-reset", { email: emails.kept, redirectTo: "/" });
  expect(reset.status === 200, `reset request returned ${reset.status}`);
  const gone = await post("/api/auth/delete-user", { password }, {
    cookie: deleted.cookie,
  });
  expect(gone.status === 200, `account deletion returned ${gone.status}`);

  ctx.step("precondition: every kind of data the drill must NOT restore exists in the source");
  const before = await factsExec(names.sourceApp);
  const b = before.db;
  expect(b, "The source database is missing.");
  expect(b.keptUserPresent && b.photoCount === 1 && b.wardrobeRevision !== null, "kept data was not seeded");
  expect(!b.deletedUserPresent && b.deletedUserRecorded, "the deleted account is not recorded as deleted");
  expect(b.sessions > 0, "no live session was seeded");
  expect(b.verifications > 0, "no password-reset token was seeded");
  expect(b.analysisJobs > 0, "no temporary analysis photo was seeded");
  expect(b.rateLimitRows > 0, "no rate-limit row was seeded");
  expect(b.credentialPasswords > 0, "no credential password was seeded");
  expect(before.mailCaptureFiles > 0, "no captured mail was seeded");

  // 3. The real backup command, on the live source volume -----------------------
  ctx.step("run the real backup:encrypted command against the live source volume");
  const made = await ctx.docker(
    cliRunArgs({
      image,
      runId,
      volume: names.volumes.source,
      script: "backup-encrypted",
      secretsVolume: names.volumes.secrets,
      secretFile: PASSPHRASE_FILE,
    }),
  );
  expect(/Encrypted backup package published/.test(made.stdout), "the backup command did not report publication");
  const after = await factsExec(names.sourceApp);
  expect(after.packages.length === 1 && after.partials === 0, "expected exactly one package and no partial");
  const pkg = after.packages[0];
  expect(pkg.mode === "600" && pkg.uid === STYLE_UID, "the package must be 0600 and owned by the image user");
  expect(after.exportsDirMode === "700", "the exports directory must be 0700");
  expect(after.plainBackups === 0, "the plain backup must be removed after publication");

  // 4. Transfer the artifact to different, fresh volumes ------------------------
  ctx.step("copy the package out to the host and into a different, empty volume");
  await ctx.docker(
    copyOutArgs({ image, runId, volume: names.volumes.source, hostDir: ctx.hostDir, fileName: pkg.name, hostUid, hostGid }),
  );
  const bytes = readFileSync(hostPackage(pkg.name));
  expect(bytes.length > 4096, "the transferred package looks too small");
  const freshBefore = await factsRun(names.volumes.fresh);
  expect(!freshBefore.dbExists && freshBefore.packages.length === 0, "the fresh volume must start empty");
  await ctx.docker(copyInArgs({ image, runId, volume: names.volumes.fresh, hostDir: ctx.hostDir, fileName: pkg.name }));

  ctx.step("stop and remove the source app");
  await ctx.docker(["stop", "-t", "20", names.sourceApp]);
  await ctx.docker(["rm", "-f", "-v", names.sourceApp]);

  // 5. Negative cases on an empty volume ----------------------------------------
  ctx.step("negative cases: wrong passphrase, tampered package, truncated package");
  const tamperedName = "style-package-2026-01-01T00-00-00-000Z.stylepkg";
  const truncatedName = "style-package-2026-01-02T00-00-00-000Z.stylepkg";
  const tampered = Buffer.from(bytes);
  tampered[Math.floor(tampered.length / 2)] ^= 0x01;
  writeFileSync(hostPackage(tamperedName), tampered, { mode: 0o600 });
  writeFileSync(hostPackage(truncatedName), bytes.subarray(0, bytes.length - 40), { mode: 0o600 });
  for (const name of [pkg.name, tamperedName, truncatedName])
    await ctx.docker(copyInArgs({ image, runId, volume: names.volumes.negative, hostDir: ctx.hostDir, fileName: name }));
  const refusals: { name: string; secretFile: string; code: string }[] = [
    { name: pkg.name, secretFile: WRONG_PASSPHRASE_FILE, code: "RESTORE_E_PKG_AUTH" },
    { name: tamperedName, secretFile: PASSPHRASE_FILE, code: "RESTORE_E_PKG_AUTH" },
    { name: truncatedName, secretFile: PASSPHRASE_FILE, code: "RESTORE_E_PKG_TRUNCATED" },
  ];
  for (const refusal of refusals) {
    const r = await ctx.docker(
      cliRunArgs({
        image,
        runId,
        volume: names.volumes.negative,
        script: "restore-encrypted",
        args: [refusal.name],
        secretsVolume: names.volumes.secrets,
        secretFile: refusal.secretFile,
        confirmRestore: true,
      }),
      { allowFail: true },
    );
    expect(r.code === 1 && r.stderr.includes(refusal.code), `expected ${refusal.code} to be refused with exit 1`);
    const f = await factsRun(names.volumes.negative);
    expect(!f.dbExists, "a refused restore must not create app.db");
    expect(f.stagingEntries === 0 && f.pendingFiles === 0, "a refused restore must leave no decrypted staging");
  }

  // 6. The real restore onto the genuinely fresh volume -------------------------
  ctx.step("run the real restore:encrypted command onto the fresh volume");
  const restored = await ctx.docker(
    cliRunArgs({
      image,
      runId,
      volume: names.volumes.fresh,
      script: "restore-encrypted",
      args: [pkg.name],
      secretsVolume: names.volumes.secrets,
      secretFile: PASSPHRASE_FILE,
      confirmRestore: true,
    }),
  );
  expect(/ALL sign-in passwords were invalidated/.test(restored.stdout), "the restore did not report password invalidation");

  ctx.step("verify the restored volume");
  const fresh = await factsRun(names.volumes.fresh, {}, false);
  const r = fresh.db;
  expect(fresh.dbExists && r, "restore did not create app.db");
  expect(fresh.dbOwnerUid === STYLE_UID, "app.db must be owned by the image user");
  expect(r.integrity === "ok", "integrity_check failed");
  expect(r.keptUserPresent, "the kept account did not return");
  expect(r.photoCount === 1 && r.photoHash === b.photoHash, "the kept photo did not return unchanged");
  expect(
    r.wardrobeRevision === b.wardrobeRevision && r.wardrobeHash === b.wardrobeHash,
    "the kept wardrobe did not return unchanged",
  );
  expect(!r.deletedUserPresent && r.deletedUserRows === 0, "the deleted account (or its data) came back");
  expect(r.deletedUserRecorded, "the deletion record did not come back");
  expect(
    r.sessions === 0 && r.verifications === 0 && r.mailOutbox === 0 && r.analysisJobs === 0 && r.rateLimitRows === 0,
    "sessions, reset tokens, queued mail, analysis photos or rate-limit rows came back",
  );
  expect(fresh.mailCaptureFiles === 0, "captured mail came back");
  expect(r.credentialPasswords === 0, "a credential password survived the restore");
  expect(fresh.stagingEntries === 0 && fresh.pendingFiles === 0, "decrypted staging was left behind");

  // 7. The restored app starts and works ----------------------------------------
  ctx.step("start the real image on the restored volume; old password refused, reset works");
  await startApp(names.restoredApp, names.volumes.fresh);
  expect((await signIn(emails.kept, password)).status !== 200, "the old password still works after the restore");
  expect((await signIn(emails.deleted, password)).status !== 200, "the deleted account can sign in");
  const again = await post("/api/auth/request-password-reset", { email: emails.kept, redirectTo: "/" });
  expect(again.status === 200, `reset request on the restored app returned ${again.status}`);
  const resetLink = await mailLink(names.restoredApp, emails.kept, "Reset your password");
  const token = resetLink.pathname.split("/").filter(Boolean).at(-1) ?? "";
  expect(token.length > 8, "the reset link carried no token");
  const done = await post("/api/auth/reset-password", { newPassword: resetPassword, token });
  expect(done.status === 200, `password reset returned ${done.status}`);
  expect((await signIn(emails.kept, resetPassword)).status === 200, "sign-in after the reset failed");

  // 8. A wrong passphrase against the now-LIVE restored database ----------------
  ctx.step("wrong passphrase against the live restored database changes nothing");
  await ctx.docker(["stop", "-t", "20", names.restoredApp]);
  const hash1 = (await factsRun(names.volumes.fresh, { HASH_DB: "1" })).dbSha256;
  expect(hash1, "could not hash app.db");
  await ctx.docker(copyInArgs({ image, runId, volume: names.volumes.fresh, hostDir: ctx.hostDir, fileName: tamperedName }));
  const live = await ctx.docker(
    cliRunArgs({
      image,
      runId,
      volume: names.volumes.fresh,
      script: "restore-encrypted",
      args: [pkg.name],
      secretsVolume: names.volumes.secrets,
      secretFile: WRONG_PASSPHRASE_FILE,
      confirmRestore: true,
    }),
    { allowFail: true },
  );
  expect(live.code === 1 && live.stderr.includes("RESTORE_E_PKG_AUTH"), "a wrong passphrase must be refused on a live database");
  const tamperedLive = await ctx.docker(
    cliRunArgs({
      image,
      runId,
      volume: names.volumes.fresh,
      script: "restore-encrypted",
      args: [tamperedName],
      secretsVolume: names.volumes.secrets,
      secretFile: PASSPHRASE_FILE,
      confirmRestore: true,
    }),
    { allowFail: true },
  );
  expect(tamperedLive.code === 1 && tamperedLive.stderr.includes("RESTORE_E_PKG_AUTH"), "a tampered package must be refused on a live database");
  const hash2 = (await factsRun(names.volumes.fresh, { HASH_DB: "1" })).dbSha256;
  expect(hash2 === hash1, "app.db changed during a refused restore");
}

// --- command line ----------------------------------------------------------------

async function main(): Promise<void> {
  const docker = realDocker();
  if (process.argv.includes("--cleanup-only")) {
    await cleanupAll(docker);
    return;
  }
  await runDrill({
    docker,
    image: process.env.IMAGE || "style-studio:ci",
    port: Number(process.env.DRILL_PORT || 3100),
  });
}

if (process.argv[1] && /ci-backup-drill\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((error) => {
    console.error("Backup drill FAILED:", error instanceof Error ? error.message : "unexpected error");
    process.exit(1);
  });
}
