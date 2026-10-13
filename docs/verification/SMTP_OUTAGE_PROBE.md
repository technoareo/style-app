# Closed-port SMTP probe — 12 October 2026

Codex ran the current auth implementation in an isolated disposable database with SMTP pointed at the closed local port 127.0.0.1:1. No real email was sent and no external relay was used. A disposable signup returned a user normally; the failed connection was logged by Better Auth; the process remained alive three seconds later and exited successfully.

The installed Better Auth 1.7.7 implementation in node_modules/better-auth/dist/context/create-context.mjs, lines 215–224, passes `promise.catch(...)` to the configured background handler in `runInBackgroundOrAwait`. This explains this result. The hypothesized signup SMTP crash was not reproduced, and must not be reported as a confirmed P0. This probe does not cover every possible callback or failure path.

The durability defect remains: the message is lost rather than persistently retried, and this probe does not establish restart delivery, recipient throttling, live relay deliverability or token/outbox atomicity. Those require implementation and meaningful tests. No private credentials, tokens or message bodies were inspected or logged in this probe.
