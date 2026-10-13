# Corrected build009 review evidence

NOT approved for public launch. Frozen133 SHA256-verified readonly source/config/test files in SOURCE_MANIFEST.json; currenthashes match after final verification,0changed. No runtime data, secrets, compiled output or personal photos included. Older failed build009 and build006–008 snapshots preserved.

Passed root checks on corrected source:
- TypeScript passed.
- Fullbackend89total88pass1Windows file-symlink skip,125.114seconds. Includes real worker sustainedhealth/frozenloop/shutdown, abruptbackupkill, contenderserialization, liveblockedowner, failurecleanup, no-overwrite, migrations, auth/queue/concurrency and revoked-password restore.
- Same80second blocked-owner production-module reproduction nowpasses: secondbackuprefused at65seconds, liveowner andpartialretained, firstownerexit0. See docs/verification/live-owner-backup-lock-009-corrected.json.
- Nextproduction compile/lint/types/pages passed. BUILD_ID uQcx9u-SKHj4_wfgHvJQQ. Trace sanitizer removed23616 private references from16 manifests and1generatedprivatepath; packaging passed, realdata untouched.
- Final isolated standalone startup/accountverification/signin/privatephoto upload+download/wardrobe/API routes passed with no ancestor project node_modules.
- Desktop/mobile-sizedChrome browser34total33pass1duplicate-mobile-signup skip,3.1minutes. Includes stable delayedoldresult and pendingcancel/newupload duplicate-cancel guards, failedsave/lostresponse/reload andaccountflows. ActualiOS/Androidphones nottested.

Corrections:
- Initialproper-lockfile lease lostownership whenowner's mainthread blocked80seconds; root reproduced. Keeperthread rewrite thenstale-observation/path-rename race stolefreshowner, alsoreproduced. FinaldirectoryLock.ts is dedicatedSQLite BEGINIMMEDIATE process-heldOSlock on .backup-coordinator.db, no ages/leases/takeover, separate fromliveDB/gate. Killedprocess kernelreleaseslock; frozenliveprocess retains. Newtests prove serialization/reclaim/blockedowner; localfilesystem assumed.
- Backup rawcopies remain .partial untilsanitized+verified+published, cleanupfailures observable, finalpublication no-overwrite. Coordinator excluded frombackupselection.
- Restore nulls ALL credentialpasswords; old/new/currentpreviouspasswords refused, emailreset selfservice recoversvalidusers; deleteduserskeptdeleted andphotos/wardrobespreserved. Fresh-server restore/exportedlatestledger notimplemented.
- Cancel capturesjob/controlleridentity, duplicatependingendrequests guarded; lateoldcancel cannotabortnewflow. Tests useeventlatches andrealUIcompletion, notsetInputFiles ondisabledpicker fornormalflow.
- Mail tests deterministically ordersender-start/success/cancel and unstartedclaim; heldfreeze release waitsactualCLIhealthread, atomicswaiting notCPUspin; startup/workload gated rather thanfixed durationassumptions.

Notes include historical abandonedlease descriptions; judgeFINALsource and latestcorrectionsections asauthoritative. Read source/tests, not justnotes. Olderfailures inBUILD009_FINDINGS.md are historical unless shownstillpresent; latestchecksabove supersede their redstatus.

Remainingrequiredwork: densewholewardrobe (4B naturalcloset240sfailed;2Bfullschema219slength2048invalid;compact2B202sstop butinvalidgeometry; otherdiagnostics andnativecornerprobe240stimeouts, latterunder concurrenttestload—notaccuracy/capacitybenchmark); physicalsecuredelete/WAL maintenance/markers; freshhostrestore/latestexportedledger; scheduled encryptedoffsitebackups/drill; publicSMTP TLS/AUTH/realrelay+dropvisibility/secret scoping; Docker/Linux/targethost/domain/HTTPS; heldoutrecognition andactualconsumerdevices; operationalalerts/policies. Root's newGroundingDINO detector research is NOTimplemented in this frozenapp; Python benchmarklibraryfailedWindowsc10DLLinit beforeinference; Nodevariant preparation only. No newdetectorperformanceclaim.

Review frozen ../release-snapshots/build-009-corrected ONLY. Write MAIN docs/reviews/build-009-corrected-claude.md. Code-only review is notexecutionevidence. No implementation orsnapshot edits; no shell/runtime/secrets/photo reads.
