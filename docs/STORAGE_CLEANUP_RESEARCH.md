# Storage cleanup implementation constraints (root research)

Verified12October2026 against official SQLite references:
- https://www.sqlite.org/pragma.html#pragma_secure_delete
- https://www.sqlite.org/pragma.html#pragma_wal_checkpoint
- https://www.sqlite.org/lang_vacuum.html

Secure deletion must be enabled on every modifying connection. It does not retrospectively purge traces of earlier deletions; an offline vacuum of existing databases is a separate upgrade operation. FULL/RESTART/TRUNCATE checkpoints can be blocked by readers; successful TRUNCATE reduces WAL to zero. Check returned busy/frame counts, retry safely, and never unlink a live WAL. A vacuum rebuild can remove previously deleted content but is a write operation requiring sufficient disk space; do not run it inside transactions or casually in request handlers. These mechanisms are not guarantees of operating-system snapshots or hardware erasure.

Design requirements inferred for the next Claude batch:
- Actual queue cancel/discard/expiry/account/mail cleanup must trigger durable pending cleanup state, not only an in-memory flag lost on restart.
- Dedicated maintenance process handles expiry even without user traffic or healthy AI/mail workers. Bound each sweep and own leases. Distinguish logical cleanup from physical scrub completion, with private safe operator status/alerts and retry across held readers. Avoid long synchronous blocking in web/auth processes or gate re-entry.
- Main/auth/maintenance connections must enable and verify secure_delete=ON. Preserve auth isolation, write-gate budgets, migrations, owned saved photos and deletion ledger.
- New-upgrade startup must not blindly VACUUM an unknown database inside live auth transactions. Provide explicit stopped-service upgrade procedure or carefully isolated bounded maintenance, and candid legacy cleanup status.
- Marker tests use disposable synthetic payloads only: actual queued/running/completed job cancel/discard/expiry, account deletion and mail-body cleanup, main file and WAL before/after maintenance. Hold another process reader so checkpoint is blocked; assert logical cleanup remains correct and physical cleanup retries after release. Preserve a second tenant and saved referenced photo throughout; test restart.
- Current user wording remains truthful until these checks pass. Backups and disk-level retention are separate. Dense recognition and fresh restore remain required work.
