# Implementation 037 — FashionCLIP hardening

Scope is deliberately limited to Claude's post-`f82bf80` hardening request.
FashionCLIP remains disabled by default and is not approved for beta or public
use.

## Implemented

- Exact publisher revision and per-file SHA-256 manifest; inference is offline
  and loads only `open_clip_model.safetensors`.
- Hash-locked Python dependency graph and `pip-audit` gate. Pillow was upgraded
  from vulnerable 12.0.0 to fixed 13.0.0 after the audit found advisories.
- Child environment allowlist (no application secrets), bounded stdout/stderr,
  whole-process-tree termination, strict output schema, input byte/pixel/format
  checks, and a one-process concurrency default.
- One timeout budget across FashionCLIP plus Qwen fallback.
- Internal provider/model/version/per-field provenance. Consumer evidence no
  longer displays uncalibrated percentages.
- Optional `fashion-vision` Docker target; the default image remains unchanged.
- Owner-test-only model licence register; FashionCLIP and BiRefNet remain
  blocked for beta/public use.

## Local evidence

- Typecheck: pass.
- Lint: pass.
- 26 focused provider/dependency/deployment tests: pass.
- npm production audit: zero known vulnerabilities.
- Python lock audit: zero known vulnerabilities after the Pillow upgrade.
- Strict offline rights-cleared fixture: pass, 10.14 seconds (not a consumer
  latency claim and still above the future 3-second warm-worker gate).
- Docker is not installed on this Windows host. Linux CI now builds both the
  ordinary image and the optional FashionCLIP target.

## Known blockers retained

- The broader legacy vision integration suite is not clean on this Windows
  host and the Next production build still needs Linux CI evidence.
- No 80-image calibration benchmark and no persistent warm worker yet. Those
  remain Build 2 gates before enabling the provider.
