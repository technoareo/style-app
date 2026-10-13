import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import net from "node:net";
import tls from "node:tls";
import nodemailer from "nodemailer";
import { getDataDir } from "./database";

/**
 * Message templates, recipient checks and the final delivery step (SMTP, or a
 * private file capture for local development). Nothing here is called from a
 * request: requests only enqueue into the durable outbox (mailOutbox.ts) and
 * the supervised mail worker (scripts/mail-worker.ts) calls
 * {@link deliverMessage}. Delivery is at-least-once.
 */

export function isPublicDeployment(): boolean {
  return process.env.STYLE_PUBLIC_DEPLOYMENT === "true";
}

export function smtpUrl(): string | undefined {
  return process.env.SMTP_URL?.trim() || undefined;
}

/**
 * True when messages are captured to a private local file instead of being
 * sent: no SMTP relay configured and not a public deployment. Never true for a
 * public deployment (assertMailConfigured refuses to start one without SMTP).
 */
export function usesLocalCapture(): boolean {
  return !smtpUrl() && !isPublicDeployment();
}

function mailFrom(): string {
  return process.env.MAIL_FROM?.trim() || "Style Studio <no-reply@localhost>";
}

/**
 * Startup gate: a public deployment must have real mail delivery
 * configured, since account recovery depends on it.
 */
export function assertMailConfigured(): void {
  if (isPublicDeployment() && (!smtpUrl() || !process.env.MAIL_FROM?.trim()))
    throw new Error(
      "Public deployment requires SMTP_URL and MAIL_FROM to be configured.",
    );
}

/** What an aborted send throws; classifyMailError maps it to "timeout". */
function sendAborted(): Error {
  return Object.assign(new Error("send timeout"), {
    code: "EMAIL_SEND_TIMEOUT",
  });
}

const CONNECT_TIMEOUT_MS = 10_000;
/** After a successful send nodemailer ends the socket; this is only the backstop. */
const LINGER_MS = 2_000;

/**
 * Opens the TCP (or TLS, for smtps://) connection ourselves so that THIS send
 * owns a handle it can destroy. Resolves with a connected socket; destroys it
 * and rejects if the signal aborts or the connect itself times out.
 */
function openSocket(
  url: URL,
  signal: AbortSignal | undefined,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(sendAborted());
    const secure = url.protocol === "smtps:";
    const port = Number(url.port) || (secure ? 465 : 587);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const socket: net.Socket = secure
      ? tls.connect({
          host,
          port,
          servername: net.isIP(host) ? undefined : host,
        })
      : net.connect({ host, port });
    // Stays attached for the socket's life: nodemailer swaps its own
    // listeners, and an error between hand-over and that must never be fatal.
    socket.on("error", () => {});
    const finish = (error: Error | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeListener(secure ? "secureConnect" : "connect", onConnect);
      socket.removeListener("error", onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else resolve(socket);
    };
    const onConnect = () => finish(null);
    const onError = (error: Error) => finish(error);
    const onAbort = () => finish(sendAborted());
    const timer = setTimeout(
      () => finish(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })),
      CONNECT_TIMEOUT_MS,
    );
    socket.once(secure ? "secureConnect" : "connect", onConnect);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One SMTP delivery on its OWN transport and its OWN connection, cancellable.
 *
 * Why not a shared cached transport: nodemailer's plain transport gives the
 * caller no handle on the connection it opens per message, so a deadline could
 * only be a Promise.race that abandons a still-running send. Here the
 * transport's `getSocket` hook hands nodemailer a socket this function created
 * and tracks. On abort every tracked socket is destroyed (TCP/TLS closed, and
 * a STARTTLS wrapper dies with the socket underneath it); nodemailer then
 * fails the send and clears its own timers. Nothing is shared between sends,
 * so cancelling one can never close or disturb another.
 *
 * If the signal aborts after the relay already received the message but
 * before its acknowledgement reached us, the relay may still deliver it: that
 * is the at-least-once caveat, not a cancellation failure.
 */
async function sendOverSmtp(
  url: string,
  mail: Message,
  messageId: string | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) throw sendAborted();
  const parsed = new URL(url);
  const secure = parsed.protocol === "smtps:";
  const sockets = new Set<net.Socket>();
  const transport = nodemailer.createTransport({
    url,
    // Tighter than the whole-send deadline; each is cleared by nodemailer
    // when its connection closes.
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    dnsTimeout: 10_000,
    getSocket: (_options, callback) => {
      openSocket(parsed, signal).then(
        (socket) => {
          sockets.add(socket);
          // `connection` = an already-open socket; `secured` = smtps already done.
          callback(null, { connection: socket, secured: secure });
        },
        (error: Error) => callback(error, false),
      );
    },
  });
  const destroyAll = () => {
    for (const socket of sockets) socket.destroy();
  };
  const onAbort = () => destroyAll();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await transport.sendMail({
      from: mailFrom(),
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      ...(messageId ? { messageId } : {}),
    });
  } catch (error) {
    destroyAll();
    // The destroyed socket makes nodemailer report a generic connection
    // error; the cause was the deadline.
    throw signal?.aborted ? sendAborted() : error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    transport.close();
    // Backstop only: nodemailer has ended the socket; make sure nothing lingers.
    const linger = setTimeout(destroyAll, LINGER_MS);
    linger.unref?.();
  }
}

const HEADER_INJECTION = /[\r\n]/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertNoHeaderInjection(value: string, field: string): void {
  if (HEADER_INJECTION.test(value))
    throw new Error(
      `Refusing to send mail: ${field} contains invalid characters.`,
    );
}

export function assertAccountRecipient(to: string): void {
  assertNoHeaderInjection(to, "recipient");
  if (!EMAIL_SHAPE.test(to))
    throw new Error(
      "Refusing to send mail: recipient is not a valid email address.",
    );
}

export type Message = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Text and subject formats are relied on by the local-capture test helpers. */
export function verificationMessage(to: string, url: string): Message {
  return {
    to,
    subject: "Verify your Style Studio email",
    text: `Confirm your email address: ${url}`,
    html: `<p>Confirm your email address:</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
  };
}

export function passwordResetMessage(to: string, url: string): Message {
  return {
    to,
    subject: "Reset your Style Studio password",
    text: `Reset your password: ${url}`,
    html: `<p>Reset your password:</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
  };
}

async function writeCapture(message: Message): Promise<void> {
  const dir = path.join(getDataDir(), "mail-outbox");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(
    dir,
    `${Date.now()}-${randomBytes(6).toString("hex")}.json`,
  );
  writeFileSync(
    file,
    JSON.stringify(
      { ...message, capturedAt: new Date().toISOString() },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );
}

/**
 * Final delivery of one already-queued message. Only the mail worker (or the
 * local-capture drain in development) calls this, never a request handler.
 * Throws on failure; callers classify the error with {@link classifyMailError}
 * and must never log the message, the recipient or the error text.
 */
export async function deliverMessage(
  message: Message,
  id?: string,
  signal?: AbortSignal,
): Promise<void> {
  assertAccountRecipient(message.to);
  assertNoHeaderInjection(message.subject, "subject");
  const url = smtpUrl();
  if (url) {
    // The outbox message id becomes the Message-ID header, so a retry or a
    // duplicate after a worker crash carries the SAME Message-ID and mail
    // systems that de-duplicate on it will show one message. This narrows,
    // but does not remove, duplicate delivery: it is at-least-once.
    const domain =
      mailFrom().replace(/^.*@/, "").replace(/[^A-Za-z0-9.-].*$/, "") ||
      "style-studio.invalid";
    await sendOverSmtp(
      url,
      message,
      id && /^[A-Za-z0-9-]{8,64}$/.test(id) ? `<${id}@${domain}>` : undefined,
      signal,
    );
    return;
  }
  if (isPublicDeployment())
    throw new Error("SMTP_URL is not configured for this deployment.");
  // Local development only: private file capture.
  await writeCapture(message);
}

export type MailFailure = {
  /** Short fixed code, safe to log and store. Never contains addresses or text. */
  code: string;
  /** True when retrying cannot help (the relay refused the message itself). */
  permanent: boolean;
};

/**
 * Reduces any delivery error to a fixed code. The raw error text can contain
 * the recipient address, relay hostnames or server banners, so only an
 * allow-listed code leaves this function.
 */
export function classifyMailError(error: unknown): MailFailure {
  const e = (error ?? {}) as {
    code?: unknown;
    responseCode?: unknown;
    name?: unknown;
  };
  const response = typeof e.responseCode === "number" ? e.responseCode : 0;
  if (response >= 500 && response < 600)
    return { code: "smtp-5xx", permanent: true };
  if (response >= 400 && response < 500)
    return { code: "smtp-4xx", permanent: false };
  const code = typeof e.code === "string" ? e.code : "";
  switch (code) {
    case "EENVELOPE":
      return { code: "envelope", permanent: true };
    case "EAUTH":
      return { code: "auth", permanent: false };
    case "ECONNREFUSED":
      return { code: "conn-refused", permanent: false };
    case "ETIMEDOUT":
    case "ESOCKETTIMEDOUT":
    case "ECONNECTION_TIMEOUT":
      return { code: "timeout", permanent: false };
    case "ECONNRESET":
    case "ESOCKET":
    case "ECONNECTION":
      return { code: "conn", permanent: false };
    case "EDNS":
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return { code: "dns", permanent: false };
    case "EMAIL_SEND_TIMEOUT":
      return { code: "timeout", permanent: false };
    default:
      return { code: "error", permanent: false };
  }
}
