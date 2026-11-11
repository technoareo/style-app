# Implementation 027: file identity bound to the opened handle

Status: implemented; test evidence below. **Uncommitted** (no commit, no push). The app is **not launch-ready**: this build changes how the intake tool reads files and nothing else. No real photo, label or model result exists in the repository, and recognition remains unmeasured.

## The finding

Independent review of Build 026: `readSourceFile` and `readWorkspaceFile` in `scripts/vision-evaluation/single-item/fsx.ts` tied stability mainly to size and modification time and never proved that the opened file descriptor was the file observed before the open. A co-resident process could swap in a same-size, same-mtime regular file between `lstat`/`realpath` and `open`/`read`, then swap the original back. `readWorkspaceFile` also read by path (`readFileSync(file)`) after only an `lstat`.

## What changed (scope)

Only `fsx.ts`, one refusal message in `cli-intake.ts`, one new test file and documentation. The exclusive-write and rollback code (`writeExclusive`, `Creations`, `FsOps`) is untouched apart from one message that no longer echoes a file name.

1. **One read routine for everything.** Both `readSourceFile` and `readWorkspaceFile` now end in the same private `readBound`: the caller `lstat`s the path (regular file, not a link); the file is opened and the **opened handle** is `fstat`ed and must be the same file as that observation; bytes are read **only through that handle** (no path-based read, no second open); then the handle is `fstat`ed again and the path is `lstat`ed again, both must still be that same file, and the byte count must equal the size. Any mismatch is a refusal and nothing is returned.
2. **What "same file" compares** (`sameFile`): the file index (inode / NTFS file ID) **and** device, but only when the platform supplies a non-zero index (a zero index means "not provided" and is never treated as identity; one observation with an index and the other without is a mismatch); and, always, size, modification time, change time and creation time, at nanosecond resolution where Node supplies it. Stats are taken with `{ bigint: true }`, so a 64-bit file ID or a nanosecond timestamp is never rounded.
3. **Every workspace evidence path is covered**, because they all go through `readWorkspaceFile`: policy, coverage spec, sample plan, batch file, review and adjudication files, intake records, `workspace.json`, `seal.json`, pooled images (including the post-copy re-hash and the freeze-time re-read). A test asserts that `intake.ts`, `review.ts`, `sampling.ts` and `cli-intake.ts` contain no other `readFileSync`.
4. **Existing protections are kept**: bare-name rules, `lstat` refusal of symbolic links and junctions, non-regular files, hard-linked source photos, containment through `realpath.native`, size limits (workspace reads now also have a 64 MB cap).
5. **Privacy**: refusals from the read and write layers are generic. They contain no file name or path, including the operator's source names and operator-named evidence files (the previous "already exists" and "is not valid JSON" messages used the file's base name).
6. **Output side unchanged**: no `renameSync`, `linkSync`, `copyFileSync`, recursive deletion or path-based re-read after the handle is trusted (a source-guard test checks `fsx.ts`).

## Guarantee, stated precisely

Where the platform reports a file index (NTFS and ext4/APFS volumes normally do), a different regular file swapped in before the open, swapped in before the open and back after it, or swapped in and left after the read, is refused even if it has the same size and modification time, because its file index, change time or creation time differs from what was observed. Bytes are always the bytes of the handle that was verified. A swap in and back **during** the read cannot alter the result: the handle still names the original file.

## Remaining limit

- If a volume or file system reports **no file index** (zero), the decision rests on size and the three timestamps. A swapped file that matches in size and every timestamp is then indistinguishable, and the read reports `identity: "size-and-timestamps"` rather than claiming a file-index proof. A test records this limit.
- Even with a file index, NTFS can reuse the file ID of a just-deleted file and "tunnel" its creation time onto a file re-created under the same name; the change time normally still differs. A privileged process that can set change times or rewrite the volume can defeat any user-space check. The real-file swap test therefore skips itself, with a stated reason, on a volume where the two files cannot be told apart.
- This is not a lock: the operator's own process can still be raced and will refuse, not wait. Another process with write access to the workspace can still rewrite evidence consistently between runs; strict parsing and pooled-image re-hashing catch accidents and partial edits, not a determined forger.
- Nothing here was run on the root's managed Windows sandbox, against Ollama, or with real photos.

## Test evidence

New file `tests/singleItemFileIdentity027.test.ts`, run on the Windows 11 development machine. Injected in-memory file system (same tests applied to the source-photo reader and the workspace-evidence reader): clean read through one open and one handle read; same-size same-mtime swap before the open refused; swap before and back after the open refused; different device refused; swap persisting after the read refused; swap in and back during the read leaves the handle's own bytes; with no file index, a differing change, creation or modification time refuses; file index on one side only refused; shrinking content refused; a directory or link appearing refused; refusals contain no file name; the documented no-index limit; link, hard-link, containment, size and missing-file protections unchanged. Real files: round trip, handle/path agreement, a real delete-and-recreate swap (skipped with a reason if the volume cannot distinguish the files) and an in-place rewrite during the read.

## Reviewer blocker after root's validation: operating-system errors leaked paths

An independent reviewer found that `readBound` did not sanitize failures from `ops.open(full)`, and that `fstat` or `readAll` could also throw raw Node errors. Those errors carry the full path and an errno (for example `ENOENT: ... open 'C:\Users\...\photo.jpg'`), so through `importBatch` and `cli-intake` an ordinary delete, rename or access race could print the source or batch path, contradicting the privacy guarantee stated above. (`realpath` had the same flaw on the source path.)

Fix, all in `fsx.ts` (no other code changed):

- `readBound` now turns a failure of `open`, the first `fstat`, `readAll` and the post-read `fstat` into one fixed refusal ("a file could not be read (it may have been moved, deleted or made inaccessible); nothing was read"). Node's message, path, errno, error code and syscall name are discarded, never copied into the refusal.
- The handle is closed on every outcome. If a failure is already in flight (a sensitive OS error, an identity mismatch), that failure is the one reported, and a close error is swallowed and not added to it. If the read succeeded and only the close fails, the read fails closed with the same generic refusal and no bytes are returned. A failed `open` has no handle, so nothing is closed.
- `realpath` failures (source directory or file) are replaced by a generic "could not be resolved" refusal.
- Unchanged: identity binding, size limits, link and hard-link refusal, containment, bytes only through the handle (no path-based reread), exclusive write and rollback.

New tests in `tests/singleItemFileIdentity027.test.ts`, each applied to both the source-photo reader and the workspace-evidence reader on the injected file system: path deleted or renamed between `lstat` and `open`; `open` throwing sensitive errors (EACCES, EBUSY, EPERM, EIO); first `fstat`, `readAll` and post-read `fstat` throwing sensitive errors, with the handle closed exactly once; close failing after a good read; close failing while a `readAll` error or an identity mismatch is already active (the earlier failure's message wins); one open and one close on success and on failure. Plus a `realpath` failure test and a command-line test that an unreadable policy, coverage or batch file gives exit 2 with a message that names no path. Every message is checked to contain no path fragment, file name, OS error code, errno, syscall or quote character.

**Status of this fix: validated by root.** The builder wrote it without being able to run any command; root then ran typecheck, lint, the focused tests and the full suite on the final state and reported them (see the next section). The builder did not produce those figures.

## Validation results (reported by root, not run by the builder)

The builder could not run any command in the sessions that produced this build's code (shell commands were refused for lack of approval), so **none of the figures below were produced by the builder**. They are root's independent validation of the **final** Build 027 state (after the reviewer-blocker fix), on Windows, copied as root reported them:

- `npm run typecheck`: exit 0.
- `npm run lint`: exit 0.
- `npx tsx --test tests/singleItemFileIdentity027.test.ts tests/singleItemIntake026.test.ts`: 76 tests, 76 pass, 0 fail, 0 skipped, duration 18.3 s.
- `npm test`, run outside the managed sandbox on Windows: 677 tests, 667 pass, 0 fail, 0 cancelled, 10 skipped, duration 104.3 s.
- `git diff --check`: root reported a pass earlier in this build, before the final edits; no result for it was reported with the figures above, so none is recorded for the final state.

Superseded, for history only: before the reviewer-blocker fix root reported 62/62 for the same focused files and 663 tests (653 pass, 0 fail, 10 skipped) for the full suite. Those figures no longer describe the code.

Two things the builder can say about the final figures. First, the focused run had 0 skipped, so the conditional skips in the real-file tests (volume cannot tell a swapped file apart) did not trigger there. Second, the full suite shows 10 skipped; earlier builds reported 5 skipped in the full suite, and the builder has not diagnosed where the other 5 come from (the focused files account for none of them).

Fixes made after the first root run, for the record: bigint literals in `fsx.ts` and the 027 tests were replaced with `BigInt(...)` because the repository target is below ES2020 (`tsconfig` unchanged), and the generic read-identity refusal now contains the phrase "changed while it was being read" so the unchanged Build 026 assertion holds.

The app remains not launch-ready; none of this measures recognition.
