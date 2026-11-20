import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validatePassphrase } from "../src/server/backupPassphrase";
import { PACKAGE_FINAL } from "../src/server/encryptedBackup";
import {
  DRILL_LABEL,
  DRILL_RUN_LABEL,
  INSPECT_IN_IMAGE,
  PACKAGE_NAME,
  PASSPHRASE_FILE,
  STYLE_GID,
  STYLE_UID,
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
} from "../scripts/ci-backup-drill-plan";
import { runDrill, cleanupAll, type Docker, type DockerResult } from "../scripts/ci-backup-drill";
import { runScript } from "./helpers/processes";

/**
 * Build 022: the contract of the CI encrypted-backup drill. Docker is not
 * available where these run, so they pin what can be pinned deterministically:
 * the exact docker argument lists the drill builds (secrets, ownership,
 * labels, isolation), the cleanup guarantees under failure (with a fake docker
 * that tracks resources), the container-side inspector against a real
 * database, and the workflow wiring. The drill itself runs in GitHub's
 * Ubuntu/Docker job; this file does not claim it has.
 */

const root = path.join(process.cwd(), ".data", "tests", randomUUID());
mkdirSync(root, { recursive: true });
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const IMAGE = "style-studio:ci";
const RUN = "0123456789";
const names = drillNames(RUN);

const hasLabels = (args: string[], runId = RUN) => {
  const text = args.join(" ");
  return text.includes(`--label ${DRILL_LABEL}=1`) && text.includes(`--label ${DRILL_RUN_LABEL}=${runId}`);
};

test("run ids and resource names are fixed-shape; a bad id is refused", () => {
  assert.match(makeRunId(), /^[0-9a-f]{10}$/);
  assert.equal(drillNames(RUN).volumes.source, `style-drill-${RUN}-vol-source`);
  assert.equal(new Set(Object.values(drillNames(RUN).volumes)).size, 4, "four different volumes");
  for (const bad of ["", "../x", "ABC123", "12 34", "a".repeat(40)])
    assert.throws(() => drillNames(bad), /Invalid drill run id/);
});

test("the passphrase is strong by the product's own rules, random per call, and deterministic under an injected source", () => {
  const a = generatePassphrase();
  const b = generatePassphrase();
  validatePassphrase(a);
  validatePassphrase(b);
  assert.notEqual(a, b);
  assert.equal(a.length, 43);
  const fixed = () => Buffer.alloc(32, 7);
  assert.equal(generatePassphrase(fixed), generatePassphrase(fixed));
});

test("the secret file is written from STDIN, owned by uid/gid 1001, mode 0400, and the passphrase is in no argument", () => {
  const passphrase = generatePassphrase();
  const args = writeSecretArgs(IMAGE, RUN, names.volumes.secrets, "backup-passphrase");
  assert.ok(hasLabels(args));
  assert.ok(args.includes("-i"), "stdin is attached");
  assert.equal(findSecret([passphrase], [args.join(" ")]), undefined);
  const script = args.at(-1)!;
  assert.match(script, /umask 077/);
  assert.match(script, /cat > "\/s\/\$SECRET_NAME"/);
  assert.match(script, new RegExp(`chown ${STYLE_UID}:${STYLE_GID} `));
  assert.match(script, /chmod 0400 /);
  assert.ok(args.includes("--network") && args[args.indexOf("--network") + 1] === "none");
  assert.ok(args.includes("--cap-drop") && args[args.indexOf("--cap-drop") + 1] === "ALL");
  assert.equal(STYLE_UID, 1001, "matches the Dockerfile user");
  assert.match(read("Dockerfile"), /useradd --uid 1001 --gid 1001/);
  assert.throws(() => writeSecretArgs(IMAGE, RUN, names.volumes.secrets, "../x"), /Invalid secret file name/);
  assert.throws(() => writeSecretArgs(IMAGE, RUN, names.volumes.secrets, "a b"), /Invalid secret file name/);
});

test("operator commands run in their own confined, network-less containers and read the passphrase only from the read-only secret file", () => {
  for (const script of ["backup-encrypted", "restore-encrypted"] as const) {
    const args = cliRunArgs({
      image: IMAGE,
      runId: RUN,
      volume: names.volumes.fresh,
      script,
      args: script === "restore-encrypted" ? ["style-package-2026-01-01T00-00-00-000Z.stylepkg"] : [],
      secretsVolume: names.volumes.secrets,
      secretFile: PASSPHRASE_FILE,
      confirmRestore: script === "restore-encrypted",
    });
    const text = args.join(" ");
    assert.ok(hasLabels(args));
    assert.ok(args.includes("--rm"));
    assert.match(text, /--network none/);
    assert.match(text, /--cap-drop ALL/);
    assert.match(text, /--security-opt no-new-privileges:true/);
    assert.match(text, new RegExp(`-v ${names.volumes.secrets}:/run/secrets:ro`));
    assert.match(text, /-e STYLE_BACKUP_PASSPHRASE_FILE=\/run\/secrets\/backup-passphrase/);
    assert.doesNotMatch(text, /STYLE_BACKUP_PASSPHRASE=/, "the passphrase itself is never an environment value");
    assert.doesNotMatch(text, /--privileged|--user 0|--pid|--network host/);
    assert.ok(text.endsWith(`scripts/${script}.ts` + (script === "restore-encrypted" ? " style-package-2026-01-01T00-00-00-000Z.stylepkg" : "")));
    assert.equal(text.includes("STYLE_RESTORE_CONFIRMED=true"), script === "restore-encrypted");
  }
});

test("the app runs from the real image on its own named volume, bound to loopback only, with the inspector mounted read-only and no model", () => {
  const args = appRunArgs({
    image: IMAGE,
    runId: RUN,
    name: names.sourceApp,
    volume: names.volumes.source,
    port: 3100,
    inspectHostPath: "/work/scripts/ci-backup-drill-inspect.ts",
  });
  const text = args.join(" ");
  assert.ok(hasLabels(args));
  assert.match(text, /-p 127\.0\.0\.1:3100:3000/);
  assert.match(text, new RegExp(`-v ${names.volumes.source}:/data(\\s|$)`));
  assert.match(text, new RegExp(`:${INSPECT_IN_IMAGE}:ro`));
  assert.match(text, /APP_URL=http:\/\/127\.0\.0\.1:3100/);
  assert.doesNotMatch(text, /OLLAMA|STYLE_PUBLIC_DEPLOYMENT|--privileged|SMTP/);
  assert.ok(text.includes("scripts/init-auth.ts && exec node server.js"));
  assert.ok(text.includes(IMAGE));
});

test("inspection mounts and exec forms are labelled, offline and carry no secret values", () => {
  const run = inspectRunArgs({
    image: IMAGE,
    runId: RUN,
    volume: names.volumes.fresh,
    inspectHostPath: "/work/i.ts",
    mode: "facts",
    env: { KEPT_ID: "k", DELETED_ID: "d", SECRET_FILE: PASSPHRASE_FILE },
    secretsVolume: names.volumes.secrets,
  });
  assert.ok(hasLabels(run));
  assert.ok(run.join(" ").includes("--network none"));
  assert.ok(run.join(" ").includes(`${names.volumes.secrets}:/run/secrets:ro`));
  const exec = inspectExecArgs({ container: names.sourceApp, mode: "mail", env: { MAIL_TO: "a@example.test" } });
  assert.deepEqual(exec.slice(0, 1), ["exec"]);
  assert.ok(exec.includes(names.sourceApp));
});

test("the package moves between volumes through a host folder: install as uid 1001 0600 in a 0700 directory in, 0600 for the host user out; names are validated", () => {
  const name = "style-package-2026-03-04T05-06-07-089Z.stylepkg";
  const into = copyInArgs({ image: IMAGE, runId: RUN, volume: names.volumes.fresh, hostDir: "/tmp/h", fileName: name });
  assert.ok(hasLabels(into));
  const script = into.at(-1)!;
  assert.match(script, /install -d -o 1001 -g 1001 -m 0700 \/data\/exports/);
  assert.match(script, /install -o 1001 -g 1001 -m 0600 "\/in\/\$PKG" "\/data\/exports\/\$PKG"/);
  assert.ok(into.join(" ").includes("/tmp/h:/in:ro"), "the host folder is read-only for the copy in");
  const out = copyOutArgs({ image: IMAGE, runId: RUN, volume: names.volumes.source, hostDir: "/tmp/h", fileName: name, hostUid: 1000, hostGid: 1000 });
  assert.ok(out.join(" ").includes(`${names.volumes.source}:/data:ro`), "the source volume is read-only for the copy out");
  assert.match(out.at(-1)!, /chown 1000:1000 "\/out\/\$PKG"; chmod 0600/);
  // source and fresh are different volumes, and the transfer touches the host folder, not a shared volume.
  assert.notEqual(names.volumes.source, names.volumes.fresh);
  for (const bad of ["../x.stylepkg", "style-package-x.stylepkg", `${name}/../x`, "/etc/passwd", "a b.stylepkg"]) {
    assert.throws(() => copyInArgs({ image: IMAGE, runId: RUN, volume: "v", hostDir: "/h", fileName: bad }), /Invalid package file name/);
    assert.throws(() => copyOutArgs({ image: IMAGE, runId: RUN, volume: "v", hostDir: "/h", fileName: bad, hostUid: 1, hostGid: 1 }), /Invalid package file name/);
  }
});

test("the drill's package-name pattern accepts exactly what the product publishes", () => {
  for (const ok of [
    "style-package-2026-03-04T05-06-07-089Z.stylepkg",
    "style-package-2026-03-04T05-06-07-089Z-2.stylepkg",
  ]) {
    assert.ok(PACKAGE_FINAL.test(ok) && PACKAGE_NAME.test(ok), ok);
  }
  for (const bad of ["style-package-2026-03-04.stylepkg", "x/style-package-2026-03-04T05-06-07-089Z.stylepkg", "style-package-2026-03-04T05-06-07-089Z.stylepkg.partial"])
    assert.ok(!PACKAGE_FINAL.test(bad) && !PACKAGE_NAME.test(bad), bad);
});

test("redaction and secret search", () => {
  const secret = "SeCrEtSeCrEt-0123456789";
  assert.equal(redact(`a ${secret} b ${secret}`, [secret]), "a [redacted] b [redacted]");
  assert.equal(redact("short", ["abc"]), "short", "very short values are not treated as secrets");
  assert.equal(findSecret([secret], ["nothing", `x${secret}y`]), secret);
  assert.equal(findSecret([secret], ["nothing"]), undefined);
});

// --- cleanup guarantees, with a fake docker that tracks resources -----------------

function fakeDocker(options: { stuckVolume?: boolean } = {}) {
  const containers = new Map<string, string>();
  const volumes = new Map<string, string>();
  const calls: string[][] = [];
  const runOf = (args: string[]) =>
    args.find((a) => a.startsWith(`${DRILL_RUN_LABEL}=`))?.split("=")[1] ?? "";
  const docker: Docker = async (args) => {
    calls.push(args);
    const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "" });
    if (args[0] === "volume" && args[1] === "create") volumes.set(args.at(-1)!, runOf(args));
    else if (args[0] === "volume" && args[1] === "rm") {
      if (!options.stuckVolume) volumes.delete(args.at(-1)!);
    } else if (args[0] === "volume" && args[1] === "ls")
      return ok([...volumes].filter(([, r]) => args.join(" ").includes(r) || args.join(" ").includes(`label=${DRILL_LABEL}`)).map(([n]) => n).join("\n"));
    else if (args[0] === "run" && args.includes("-d")) containers.set(args[args.indexOf("--name") + 1], runOf(args));
    else if (args[0] === "rm") containers.delete(args.at(-1)!);
    else if (args[0] === "ps")
      return ok([...containers].filter(([, r]) => args.join(" ").includes(r) || args.join(" ").includes(`label=${DRILL_LABEL}`)).map(([n]) => n).join("\n"));
    return ok();
  };
  return { docker, calls, containers, volumes };
}

test("cleanup removes every container, volume and host file after SUCCESS", async () => {
  const fake = fakeDocker();
  let hostDir = "";
  const logs: string[] = [];
  await runDrill(
    { docker: fake.docker, tmpRoot: root, log: (l) => logs.push(l) },
    async (ctx) => {
      hostDir = ctx.hostDir;
      writeFileSync(path.join(ctx.hostDir, "style-package-2026-01-01T00-00-00-000Z.stylepkg"), "x");
      for (const v of Object.values(ctx.names.volumes)) await ctx.docker(createVolumeArgs(ctx.names.runId, v));
      ctx.containers.push(ctx.names.sourceApp);
      await ctx.docker(["run", "-d", "--name", ctx.names.sourceApp, "--label", `${DRILL_RUN_LABEL}=${ctx.names.runId}`, "img"]);
    },
  );
  assert.equal(fake.containers.size, 0);
  assert.equal(fake.volumes.size, 0);
  assert.equal(existsSync(hostDir), false, "the host folder is gone");
  assert.ok(logs.some((l) => /PASSED and cleaned up/.test(l)));
});

test("cleanup still removes everything when a step FAILS, the original error is rethrown, and the passphrase never reaches the error or the log", async () => {
  const fake = fakeDocker();
  let hostDir = "";
  let pass = "";
  const logs: string[] = [];
  await assert.rejects(
    runDrill({ docker: fake.docker, tmpRoot: root, log: (l) => logs.push(l) }, async (ctx) => {
      hostDir = ctx.hostDir;
      pass = ctx.passphrase;
      for (const v of Object.values(ctx.names.volumes)) await ctx.docker(createVolumeArgs(ctx.names.runId, v));
      await ctx.docker(["run", "-d", "--name", ctx.names.restoredApp, "--label", `${DRILL_RUN_LABEL}=${ctx.names.runId}`, "img"]);
      writeFileSync(path.join(ctx.hostDir, "package"), "x");
      throw new Error(`boom with ${ctx.passphrase} inside`);
    }),
    (error: Error) => {
      assert.match(error.message, /boom with \[redacted\] inside/);
      assert.ok(!error.message.includes(pass));
      return true;
    },
  );
  assert.equal(fake.containers.size, 0);
  assert.equal(fake.volumes.size, 0);
  assert.equal(existsSync(hostDir), false);
  assert.ok(!logs.join("\n").includes(pass));
});

test("a docker command that fails inside a step is reported with the passphrase redacted, and cleanup still runs", async () => {
  const fake = fakeDocker();
  const failing: Docker = async (args) =>
    args[0] === "boom" ? { code: 3, stdout: "", stderr: "denied " + args.at(-1) } : fake.docker(args);
  let pass = "";
  await assert.rejects(
    runDrill({ docker: failing, tmpRoot: root, log: () => undefined }, async (ctx) => {
      pass = ctx.passphrase;
      await ctx.docker(createVolumeArgs(ctx.names.runId, ctx.names.volumes.source));
      ctx.step("a failing step");
      await ctx.docker(["boom", ctx.passphrase]);
    }),
    (error: Error) => {
      assert.match(error.message, /docker boom failed during "a failing step" \(exit 3\): denied \[redacted\]/);
      assert.ok(!error.message.includes(pass));
      return true;
    },
  );
  assert.equal(fake.volumes.size, 0);
});

test("a passphrase in a docker argument or in captured output fails the drill", async () => {
  for (const mode of ["argv", "stdout"] as const) {
    const fake = fakeDocker();
    const echoing: Docker = async (args) => {
      const r = await fake.docker(args);
      return mode === "stdout" && args[0] === "info" ? { ...r, stdout: args.at(-1)! } : r;
    };
    await assert.rejects(
      runDrill({ docker: echoing, tmpRoot: root, log: () => undefined }, async (ctx) => {
        if (mode === "argv") await ctx.docker(["version", ctx.passphrase]);
        else await ctx.docker(["info", ctx.wrongPassphrase]);
      }),
      /A passphrase appeared in a docker argument or output/,
      mode,
    );
    assert.equal(fake.volumes.size + fake.containers.size, 0);
  }
});

test("cleanup that cannot remove a volume fails the drill loudly instead of passing", async () => {
  const fake = fakeDocker({ stuckVolume: true });
  await assert.rejects(
    runDrill({ docker: fake.docker, tmpRoot: root, log: () => undefined }, async (ctx) => {
      await ctx.docker(createVolumeArgs(ctx.names.runId, ctx.names.volumes.source));
    }),
    /remain after cleanup/,
  );
});

test("--cleanup-only removes anything any drill run labelled", async () => {
  const fake = fakeDocker();
  fake.containers.set("leftover-a", "ffff");
  fake.volumes.set("leftover-v", "ffff");
  const removed = await cleanupAll(fake.docker, () => undefined);
  assert.equal(removed, 2);
  assert.equal(fake.containers.size + fake.volumes.size, 0);
  assert.deepEqual(listByLabelArgs("container"), ["ps", "-aq", "--filter", `label=${DRILL_LABEL}`]);
  assert.deepEqual(listByLabelArgs("volume", RUN), ["volume", "ls", "-q", "--filter", `label=${DRILL_RUN_LABEL}=${RUN}`]);
});

// --- the container-side inspector against a REAL database -------------------------

const dataDir = path.join(root, "inspect-data");
const ids: Record<string, string> = {};
const emails = { kept: "inspect-kept@example.test", gone: "inspect-gone@example.test" };
const pw = "Inspect drill passphrase 31!";

before(async () => {
  mkdirSync(dataDir, { recursive: true });
  process.env.STYLE_DATA_DIR = dataDir;
  process.env.APP_URL = "http://127.0.0.1:3000";
  delete process.env.STYLE_PUBLIC_DEPLOYMENT;
  const { getReadyAuth } = await import("../src/server/auth");
  const { getDatabase } = await import("../src/server/database");
  const auth = await getReadyAuth();
  const db = getDatabase();
  for (const [key, email] of Object.entries(emails))
    ids[key] = (await auth.api.signUpEmail({ body: { email, name: key, password: pw } })).user.id;
  db.exec("UPDATE user SET emailVerified=1");
  await auth.api.signInEmail({ body: { email: emails.kept, password: pw } });
  db.prepare("INSERT INTO photo_assets(id,user_id,data,sha256,created_at) VALUES(?,?,?,?,?)").run("p1", ids.kept, Buffer.from("PHOTO-BYTES-MARKER"), "sha", Date.now());
  db.prepare("INSERT INTO wardrobe_spaces(user_id,revision,data_json) VALUES(?,?,?)").run(ids.kept, 2, '{"wardrobe":[]}');
  db.prepare("DELETE FROM user WHERE id=?").run(ids.gone);
  mkdirSync(path.join(dataDir, "mail-outbox"), { recursive: true });
  writeFileSync(
    path.join(dataDir, "mail-outbox", "1.json"),
    JSON.stringify({ to: emails.kept, subject: "s", text: "Reset your password: http://127.0.0.1:3100/reset-password/TOKEN12345?cb=/" }),
  );
  mkdirSync(path.join(dataDir, "exports"), { recursive: true });
  writeFileSync(path.join(dataDir, "exports", "style-package-2026-01-01T00-00-00-000Z.stylepkg"), "x");
  writeFileSync(path.join(dataDir, "exports", "style-package-2026-01-01T00-00-00-000Z.aaaaaaaaaaaa.partial"), "x");
  const { closeDatabases } = await import("../src/server/database");
  closeDatabases();
});

const inspector = (mode: string, env: Record<string, string> = {}) =>
  runScript("scripts/ci-backup-drill-inspect.ts", [mode], { STYLE_DATA_DIR: dataDir, ...env });

test("inspector facts: counts, hashes and presence from a real database, read-only, with no account data in the output", async () => {
  const dbBytes = () => createHash("sha256").update(readFileSync(path.join(dataDir, "app.db"))).digest("hex");
  const names = () => readdirSync(dataDir).filter((n) => !/-(wal|shm)$/.test(n)).sort();
  const before = { hash: dbBytes(), names: names() };
  const r = await inspector("facts", { KEPT_ID: ids.kept, DELETED_ID: ids.gone, HASH_DB: "1" });
  assert.equal(r.code, 0, r.stderr);
  const f = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
  assert.equal(f.dbExists, true);
  assert.match(f.dbSha256, /^[0-9a-f]{64}$/);
  assert.equal(f.db.keptUserPresent, true);
  assert.equal(f.db.deletedUserPresent, false);
  assert.equal(f.db.deletedUserRecorded, true, "the deletion trigger recorded the deleted account");
  assert.equal(f.db.deletedUserRows, 0);
  assert.equal(f.db.photoCount, 1);
  assert.match(f.db.photoHash, /^[0-9a-f]{64}$/);
  assert.equal(f.db.wardrobeRevision, 2);
  assert.ok(f.db.sessions >= 1 && f.db.rateLimitRows >= 0);
  assert.equal(f.db.credentialPasswords, 1);
  assert.equal(f.db.integrity, "ok");
  assert.equal(f.mailCaptureFiles, readdirSync(path.join(dataDir, "mail-outbox")).length);
  assert.ok(f.mailCaptureFiles >= 1);
  assert.equal(f.partials, 1);
  assert.deepEqual(f.packages.map((p: { name: string }) => p.name), ["style-package-2026-01-01T00-00-00-000Z.stylepkg"]);
  const out = r.stdout + r.stderr;
  for (const secret of [...Object.values(emails), ...Object.values(ids), pw, "PHOTO-BYTES-MARKER", '{"wardrobe":[]}'])
    assert.ok(!out.includes(secret), "no account data in the inspector output");
  assert.equal(dbBytes(), before.hash, "app.db is byte-identical after the inspection");
  assert.equal(f.dbSha256, before.hash, "the reported hash is the file's real hash");
  assert.deepEqual(names(), before.names, "the inspector created no file in the data folder (SQLite's own -wal/-shm bookkeeping aside)");
});

test("inspector facts on an empty folder: no database, nothing found", async () => {
  const empty = path.join(root, "empty");
  mkdirSync(empty, { recursive: true });
  const r = await runScript("scripts/ci-backup-drill-inspect.ts", ["facts"], { STYLE_DATA_DIR: empty });
  assert.equal(r.code, 0, r.stderr);
  const f = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
  assert.equal(f.dbExists, false);
  assert.equal(f.db, null);
  assert.deepEqual(f.packages, []);
  assert.equal(f.secretFile, null);
  assert.equal(readdirSync(empty).length, 0);
});

test("inspector mail: returns the link of the matching captured message only", async () => {
  const hit = await inspector("mail", { MAIL_TO: emails.kept, MAIL_TEXT: "Reset your password" });
  assert.equal(hit.code, 0, hit.stderr);
  const { link } = JSON.parse(hit.stdout.trim());
  assert.equal(new URL(link).pathname.split("/").filter(Boolean).at(-1), "TOKEN12345");
});

test("inspector refuses an unknown mode", async () => {
  const r = await inspector("rm");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /inspect failed/);
});

// --- workflow and packaging wiring -------------------------------------------------

test("the workflow runs the drill in the Docker job after the image is built and the smoke test, with a timeout and an always-run label sweep", () => {
  const yml = read(".github/workflows/ci.yml");
  const docker = yml.slice(yml.indexOf("\n  docker:"));
  const at = (needle: string) => {
    const i = docker.indexOf(needle);
    assert.ok(i >= 0, `${needle} is present in the docker job`);
    return i;
  };
  assert.ok(at("docker build -t style-studio:ci .") < at("Encrypted backup transfer and fresh restore drill"));
  assert.ok(at("Smoke test through the containers") < at("Encrypted backup transfer and fresh restore drill"));
  assert.ok(at("Encrypted backup transfer and fresh restore drill") < at("Drill cleanup sweep"));
  assert.ok(at("Drill cleanup sweep") < at("Container logs"));
  const drillStep = docker.slice(at("Encrypted backup transfer and fresh restore drill"), at("Drill cleanup sweep"));
  assert.match(drillStep, /timeout-minutes: 15/);
  assert.match(drillStep, /run: npx tsx scripts\/ci-backup-drill\.ts\s/);
  assert.match(drillStep, /IMAGE: style-studio:ci/);
  assert.doesNotMatch(drillStep, /PASSPHRASE|secrets\./i, "no passphrase or repository secret is given to the step");
  const sweep = docker.slice(at("Drill cleanup sweep"), at("Container logs"));
  assert.match(sweep, /if: always\(\)/);
  assert.match(sweep, /ci-backup-drill\.ts --cleanup-only/);
  // Bounded and offline: no model is pulled or downloaded anywhere in the drill's step.
  assert.doesNotMatch(drillStep + sweep, /ollama pull|docker pull|huggingface|curl .*model/i);
});

test("package.json exposes the drill and the image carries exactly the two commands it runs", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["ci:backup-drill"], "tsx scripts/ci-backup-drill.ts");
  const dockerfile = read("Dockerfile");
  for (const script of ["backup-encrypted", "restore-encrypted"])
    assert.ok(dockerfile.includes(`/app/scripts/${script}.ts ./scripts/${script}.ts`), script);
  // The drill's own scripts are not baked into the runtime image: the inspector is bind-mounted at run time.
  assert.ok(!dockerfile.includes("ci-backup-drill"));
});

test("static contract of the drill sources: the passphrase is only ever passed as a FILE path, never as an environment value or argument", () => {
  for (const file of ["scripts/ci-backup-drill.ts", "scripts/ci-backup-drill-plan.ts", "scripts/ci-backup-drill-inspect.ts"]) {
    const source = read(file);
    assert.doesNotMatch(source, /STYLE_BACKUP_PASSPHRASE=/, file);
    assert.doesNotMatch(source, /console\.(log|error)\([^)]*(passphrase|wrongPassphrase)/i, file);
    assert.doesNotMatch(source, /--privileged/, file);
  }
  const drill = read("scripts/ci-backup-drill.ts");
  assert.match(drill, /finally|await cleanup\(ctx\)/);
  assert.ok(!/\bOLLAMA\b|mock-ollama/.test(drill), "the drill needs no model, real or mock");
  // The drill asserts each requirement of the build: spot-check the exact failure messages exist.
  for (const message of [
    "the kept account did not return",
    "the kept photo did not return unchanged",
    "the kept wardrobe did not return unchanged",
    "the deleted account (or its data) came back",
    "sessions, reset tokens, queued mail, analysis photos or rate-limit rows came back",
    "a credential password survived the restore",
    "a refused restore must not create app.db",
    "app.db changed during a refused restore",
    "The app did not become healthy in time.",
  ])
    assert.ok(drill.includes(message), message);
});
