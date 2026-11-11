import { randomBytes } from "node:crypto";

/**
 * Build 022: the pure, deterministic part of the CI encrypted-backup drill
 * (scripts/ci-backup-drill.ts). It only BUILDS `docker` argument lists and
 * checks text; it never runs anything. tests/ciBackupDrill022.test.ts pins
 * the contract below so a later edit cannot quietly weaken it:
 *
 *  - the passphrase is never in an argument list or environment value: it is
 *    written to a root-owned-then-chowned file on a dedicated SECRETS volume
 *    through stdin, mounted read-only, and named by *_PASSPHRASE_FILE;
 *  - the secret file is owned by the image user (uid 1001) with mode 0400, the
 *    exact shape src/server/backupPassphrase.ts demands on POSIX;
 *  - every container and volume carries the drill labels, so a cleanup that
 *    starts from labels finds everything this drill created;
 *  - the package moves between two different volumes through a host folder
 *    (an artifact copy), not through a shared volume;
 *  - restore containers have no network.
 */

export const DRILL_LABEL = "style-drill";
export const DRILL_RUN_LABEL = "style-drill-run";
/** The unprivileged user the runtime image runs as (Dockerfile). */
export const STYLE_UID = 1001;
export const STYLE_GID = 1001;
export const SECRETS_MOUNT = "/run/secrets";
export const PASSPHRASE_FILE = `${SECRETS_MOUNT}/backup-passphrase`;
export const WRONG_PASSPHRASE_FILE = `${SECRETS_MOUNT}/wrong-passphrase`;
export const INSPECT_IN_IMAGE = "/app/scripts/ci-backup-drill-inspect.ts";
export const TSX = "./node_modules/.bin/tsx";
/** Same shape as PACKAGE_FINAL in src/server/encryptedBackup.ts (a test keeps them equal). */
export const PACKAGE_NAME =
  /^style-package-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?\.stylepkg$/;

export type Names = {
  runId: string;
  sourceApp: string;
  restoredApp: string;
  volumes: { source: string; fresh: string; negative: string; secrets: string };
};

export function makeRunId(random: (n: number) => Buffer = randomBytes): string {
  return random(5).toString("hex");
}

export function drillNames(runId: string): Names {
  if (!/^[0-9a-f]{6,16}$/.test(runId)) throw new Error("Invalid drill run id.");
  const base = `style-drill-${runId}`;
  return {
    runId,
    sourceApp: `${base}-source-app`,
    restoredApp: `${base}-restored-app`,
    volumes: {
      source: `${base}-vol-source`,
      fresh: `${base}-vol-fresh`,
      negative: `${base}-vol-negative`,
      secrets: `${base}-vol-secrets`,
    },
  };
}

export const labelArgs = (runId: string): string[] => [
  "--label",
  `${DRILL_LABEL}=1`,
  "--label",
  `${DRILL_RUN_LABEL}=${runId}`,
];

/** The least privilege the compose services already use. */
const CONFINED = ["--security-opt", "no-new-privileges:true", "--cap-drop", "ALL"];
/** Short-lived root helpers keep only the capabilities file copying needs. */
const ROOT_HELPER = [
  "--user",
  "0",
  "--network",
  "none",
  "--security-opt",
  "no-new-privileges:true",
  "--cap-drop",
  "ALL",
  "--cap-add",
  "CHOWN",
  "--cap-add",
  "DAC_OVERRIDE",
  "--cap-add",
  "FOWNER",
];

/** 32 random bytes as base64url: 43 characters, far above the 20/10 minimum. */
export function generatePassphrase(random: (n: number) => Buffer = randomBytes): string {
  return random(32).toString("base64url");
}

export const createVolumeArgs = (runId: string, volume: string): string[] => [
  "volume",
  "create",
  ...labelArgs(runId),
  volume,
];

/**
 * Writes one secret file onto the SECRETS volume. The passphrase arrives on
 * STDIN (the caller passes it as `input`), so it is in no argument and no
 * environment variable. umask 077 makes the file private from its first byte;
 * then it is handed to the image user and made read-only for it.
 */
export function writeSecretArgs(
  image: string,
  runId: string,
  secretsVolume: string,
  fileName: string,
): string[] {
  if (!/^[a-z-]+$/.test(fileName)) throw new Error("Invalid secret file name.");
  return [
    "run",
    "--rm",
    "-i",
    ...labelArgs(runId),
    ...ROOT_HELPER,
    "-v",
    `${secretsVolume}:/s`,
    "-e",
    `SECRET_NAME=${fileName}`,
    image,
    "sh",
    "-c",
    `set -eu; umask 077; cat > "/s/$SECRET_NAME"; chown ${STYLE_UID}:${STYLE_GID} "/s/$SECRET_NAME"; chmod 0400 "/s/$SECRET_NAME"`,
  ];
}

/** The real image, started the way the CI docker job starts it (no worker, no model needed). */
export function appRunArgs(o: {
  image: string;
  runId: string;
  name: string;
  volume: string;
  port: number;
  inspectHostPath: string;
}): string[] {
  return [
    "run",
    "-d",
    "--name",
    o.name,
    ...labelArgs(o.runId),
    ...CONFINED,
    "-p",
    `127.0.0.1:${o.port}:3000`,
    "-v",
    `${o.volume}:/data`,
    "-v",
    `${o.inspectHostPath}:${INSPECT_IN_IMAGE}:ro`,
    "-e",
    "STYLE_DATA_DIR=/data",
    "-e",
    `APP_URL=http://127.0.0.1:${o.port}`,
    o.image,
    "sh",
    "-c",
    `${TSX} scripts/init-auth.ts && exec node server.js`,
  ];
}

/** A one-off operator command in its own container, like `docker compose run --rm`. */
export function cliRunArgs(o: {
  image: string;
  runId: string;
  volume: string;
  script: "backup-encrypted" | "restore-encrypted";
  args?: string[];
  secretsVolume: string;
  secretFile: string;
  confirmRestore?: boolean;
}): string[] {
  return [
    "run",
    "--rm",
    ...labelArgs(o.runId),
    ...CONFINED,
    "--network",
    "none",
    "-v",
    `${o.volume}:/data`,
    "-v",
    `${o.secretsVolume}:${SECRETS_MOUNT}:ro`,
    "-e",
    "STYLE_DATA_DIR=/data",
    "-e",
    `STYLE_BACKUP_PASSPHRASE_FILE=${o.secretFile}`,
    ...(o.confirmRestore ? ["-e", "STYLE_RESTORE_CONFIRMED=true"] : []),
    o.image,
    TSX,
    `scripts/${o.script}.ts`,
    ...(o.args ?? []),
  ];
}

export type InspectEnv = Record<string, string>;
const envArgs = (env: InspectEnv): string[] =>
  Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

/** Inspect a data volume that no app is using (read-only mount of the data, plus the secret file when asked). */
export function inspectRunArgs(o: {
  image: string;
  runId: string;
  volume: string;
  inspectHostPath: string;
  mode: "facts" | "mail";
  env: InspectEnv;
  secretsVolume?: string;
}): string[] {
  return [
    "run",
    "--rm",
    ...labelArgs(o.runId),
    ...CONFINED,
    "--network",
    "none",
    "-v",
    `${o.volume}:/data`,
    "-v",
    `${o.inspectHostPath}:${INSPECT_IN_IMAGE}:ro`,
    ...(o.secretsVolume ? ["-v", `${o.secretsVolume}:${SECRETS_MOUNT}:ro`] : []),
    "-e",
    "STYLE_DATA_DIR=/data",
    ...envArgs(o.env),
    o.image,
    TSX,
    INSPECT_IN_IMAGE,
    o.mode,
  ];
}

/** Inspect through the running app container (mail capture, live facts). */
export function inspectExecArgs(o: {
  container: string;
  mode: "facts" | "mail";
  env: InspectEnv;
}): string[] {
  return ["exec", ...envArgs(o.env), o.container, TSX, INSPECT_IN_IMAGE, o.mode];
}

/** Host folder -> volume: install the package into `<data>/exports`, owned by the image user, 0600 in a 0700 directory. */
export function copyInArgs(o: {
  image: string;
  runId: string;
  volume: string;
  hostDir: string;
  fileName: string;
}): string[] {
  if (!PACKAGE_NAME.test(o.fileName)) throw new Error("Invalid package file name.");
  return [
    "run",
    "--rm",
    ...labelArgs(o.runId),
    ...ROOT_HELPER,
    "-v",
    `${o.volume}:/data`,
    "-v",
    `${o.hostDir}:/in:ro`,
    "-e",
    `PKG=${o.fileName}`,
    o.image,
    "sh",
    "-c",
    `set -eu; install -d -o ${STYLE_UID} -g ${STYLE_GID} -m 0700 /data/exports; install -o ${STYLE_UID} -g ${STYLE_GID} -m 0600 "/in/$PKG" "/data/exports/$PKG"`,
  ];
}

/** Volume -> host folder: the artifact copy, handed to the host user. */
export function copyOutArgs(o: {
  image: string;
  runId: string;
  volume: string;
  hostDir: string;
  fileName: string;
  hostUid: number;
  hostGid: number;
}): string[] {
  if (!PACKAGE_NAME.test(o.fileName)) throw new Error("Invalid package file name.");
  return [
    "run",
    "--rm",
    ...labelArgs(o.runId),
    ...ROOT_HELPER,
    "-v",
    `${o.volume}:/data:ro`,
    "-v",
    `${o.hostDir}:/out`,
    "-e",
    `PKG=${o.fileName}`,
    o.image,
    "sh",
    "-c",
    `set -eu; cp "/data/exports/$PKG" "/out/$PKG"; chown ${Number(o.hostUid)}:${Number(o.hostGid)} "/out/$PKG"; chmod 0600 "/out/$PKG"`,
  ];
}

/** Cleanup by label: everything one run (or, with no run id, any run) created. */
export const listByLabelArgs = (
  kind: "container" | "volume",
  runId?: string,
): string[] => {
  const filter = runId ? `${DRILL_RUN_LABEL}=${runId}` : DRILL_LABEL;
  return kind === "container"
    ? ["ps", "-aq", "--filter", `label=${filter}`]
    : ["volume", "ls", "-q", "--filter", `label=${filter}`];
};

/** Replace every secret in `text` (secrets shorter than 8 characters are ignored: they would match noise). */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join("[redacted]");
  return out;
}

/** The first secret found in any of the texts, or undefined. */
export function findSecret(secrets: readonly string[], texts: readonly string[]): string | undefined {
  return secrets.find((s) => s.length >= 8 && texts.some((t) => t.includes(s)));
}
