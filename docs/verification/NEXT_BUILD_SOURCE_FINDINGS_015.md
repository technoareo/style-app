# Source findings for the next implementation batch

These are source observations, not measured fixes. No application files were edited by the independent verifier.

`src/app/api/wardrobe/route.ts` GET calls `runWriteTransaction` unconditionally. `loadWardrobe` itself opens/joins a write transaction and calls photo reclamation, even for an empty wardrobe or a wardrobe with no reclaimable assets. Ordinary reads therefore compete with registration and worker leases. A read-first implementation must re-read current references inside any subsequent deletion transaction; using an earlier reference snapshot could delete a photo attached by a concurrent save. Missing wardrobes must retain revision zero without creating a row.

PUT wraps `saveWardrobe` in a write transaction before its schema validation, reference enumeration and JSON serialization. Pure validation and serialization can be prepared before acquisition. Photo existence/ownership, revision comparison, idempotent acknowledgement and writes must remain in the same committing transaction, with no await or stale authorization assumption. Existing repository callers need the same guarantees.

`writeTransaction.ts` releases the process gate before its three-millisecond courtesy pause. The queued waiter receives ownership immediately, so this pause does not prevent queued local writers from reacquiring SQLite. Moving scheduling requires correctness and contention tests; this observation does not prove a fairness solution.

`authDialect.ts` begin first allows the full acquisition timeout for its gate, then uses a retry closure with another full timeout for SQLite. Its documented total gate-plus-SQLite bound is consequently not enforced by one shared deadline. The next review should consider a single remaining budget without increasing deadlines. Better Auth hashing still spans the write transaction; changing that requires verifying the library's transaction semantics, reset-token atomicity and secure hashing behavior.

The recognition CLI documents decimal numbers outside its IoU range as exit two, but its unsigned decimal regex rejects negative decimal text as usage exit one. This is a documentation/contract edge, not a recognition success or the main launch blocker.

Required follow-up evidence includes the unchanged full release concurrency workload, original assertions and budgets, targeted ownership/GC races and conflict/idempotency behavior. Execution remains pending while automatic approval review is unavailable due to the usage limit. Do not bypass it through Claude or another tool.
