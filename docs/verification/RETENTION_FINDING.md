# Temporary-photo retention finding — 12 October 2026

The running build006 verification database reports `secure_delete=0` and WAL journal mode. No user record or photo content was read for that configuration check.

An isolated synthetic canary probe wrote a large marker payload, cleared its logical photo value, truncated/checkpointed WAL, closed the connection and inspected only its own generated database file. With secure deletion disabled, the logical value was null but marker bytes remained in the main database file. With secure deletion enabled before writing/clearing the payload, marker bytes were absent after checkpoint/truncation. Raw boolean evidence is `retention-canary.json`; this is not a test of hardware erasure or every app cleanup path.

The active code needs explicit scrubbing settings on every relevant connection and a bounded journal-cleanup strategy before claiming that temporary photos are removed from storage within the advertised lifetime. A regression should cover actual queued/running/completed cancellation and expiry, account deletion, main-file and WAL traces, and contention that delays checkpointing. Existing confirmed photos and the restoration deletion ledger must remain intact.

SQLite documents that enabling secure deletion overwrites deleted content and that a vacuum can remove traces left by prior updates/deletes: [official secure_delete reference](https://www.sqlite.org/pragma.html#pragma_secure_delete). Its table-content guarantee alone does not cover WAL, operating-system snapshots or physical media. Backup retention and encryption remain separate operational requirements.

This finding does not change the frozen build006 code. It is supplemental evidence for the next repair and review.
