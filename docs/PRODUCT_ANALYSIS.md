# Style Studio — product and engineering assessment

Assessment date: 11 October 2026. This document describes the implementation in this workspace. The original project at `C:/Projects/StyleApp/style-app` was left unchanged.

## Consumer promise

Photograph clothing, review the detected pieces, and get useful everyday or event combinations made exclusively from your wardrobe. Uploading a photo replaces form filling; a short review protects users from silent recognition mistakes. Styling must admit when the wardrobe cannot meet an occasion.

The first useful experience needs enough garments for a complete outfit: top + bottom + shoes, or a dress + shoes. A single shirt photo starts the wardrobe but cannot establish ownership of complementary clothes. The app therefore explains missing categories instead of inventing pieces.

## Consultation and evidence

I submitted the product and architecture brief to Claude Desktop and read its initial review. It identified that the original app demonstrated screen flow rather than reliable extraction or recommendation, and called out fixed-item outfits, duplicate identity, browser storage limits, and unreliable guesses about fit, size and fabric. I could not capture its complete answer after desktop automation detected user interaction; this is a partial consultation, not a claimed independent code audit.

I also submitted the brief to Perplexity in the browser and read its completed response: [consultation](https://www.perplexity.ai/search/6532e065-4bd2-429f-9ccd-ec8da09b197f). Its recommendations were local privacy first, explicit uncertainty, correction before saving, multi-item crop review, owned/available constraints, backups, local service security, and evaluation on real clothing images. Confidence numbers from a language model should not be advertised as measured accuracy. These suggestions informed the implementation; they do not establish that this app meets a production standard.

Primary references checked: [Ollama vision](https://docs.ollama.com/capabilities/vision), [Qwen3-VL model tags](https://ollama.com/library/qwen3-vl/tags), [Qwen3-VL upstream](https://github.com/QwenLM/Qwen3-VL). The explicit `2b-instruct` tag matters: the unqualified 2b tag selected a reasoning model and sometimes exhausted its output budget before producing JSON in our tests.

## What a photo can establish

| Attribute | Handling |
| --- | --- |
| Visible garment category, main color, pattern, sleeve, neckline, closure, visible length | AI suggestions, editable and reviewed |
| Number of visible pieces, approximate bounds | Detection suggestions; crop adjustment and discarding false detections |
| Occasion suitability | Conservative suggestion, editable dress-code field |
| Brand and size | Left blank; a printed logo does not establish a manufacturer or readable size label |
| Fabric composition, exact measurements, stretch, fit on the owner, comfort and warmth | Cannot reliably establish from a whole-garment photo; ask only when useful |
| Hidden clothes and visually overlapping items | May be missed; never claim complete wardrobe discovery |
| Ownership, cleanliness, availability, preferences | User input; ownership follows confirmed additions, availability is editable |

One clear garment against a plain background is the recommended starting point. A rack or pile is a harder discovery task. The current model supplies approximate rectangular crops, not segmentation, background removal or a virtual try-on. There is no body-shape or identity inference.

## Implemented experience

1. Empty wardrobe with optional, clearly labelled sample items; no sample clothing silently treated as owned.
2. Free local photo analysis using Ollama Qwen3-VL 4b Instruct; one or several visible items per photo.
3. JPEG/PNG/WebP validation, size and pixel limits, rotation, resizing, metadata stripping, local consent and cancellation.
4. Editable detections, evidence, crop adjustment, discard, and mandatory confirmation before adding. Exact normalized-photo duplicates are rejected; near-duplicate recognition is not implemented.
5. Clothing editor for visible attributes, category, optional brand/size, dress code, warmth and availability. Manual entry remains available when analysis fails.
6. Complete outfit construction from reviewed available items with category slots, color/pattern heuristics, event selection and a manually entered temperature. Formal outfits require confirmed formal pieces. Hot-weather exclusions use confirmed warmth; unknowns carry a warning. Confirmed seasons and occasions rank pieces (explicit mismatches last, untagged neutral) and never exclude them; related occasion tags are neutral-to-positive, a layer never changes the main outfit’s verdict, and saved looks keep the chosen season.
7. Another combination, saved outfit snapshots, local profiles, persistent IndexedDB storage, backup export and validated restore into a separate profile.
8. Mobile and desktop layouts, focus-trapped dialogs, keyboard dismissal, readable errors and explicit recovery paths.

Temperature is entered by the user; the app does not claim live weather. Styling is a deterministic rules engine rather than an AI taste model. It has no wear history, laundry schedule, style learning, travel packing, shopping recommendations or calendar integration yet. Saved looks preserve the original snapshot even after editing an item, which is useful for history but means a saved look can retain an old photo until that look is removed.

## Architecture and privacy

The Next.js browser client normalizes uploads, checks exact-photo hashes, and sends them to the same-origin local analysis route. The route validates again, creates an inference copy, calls a fixed loopback Ollama service, verifies structured output, and returns approximate crops for review. Only confirmed crops enter the wardrobe. The route does not persist original uploads to disk. It accepts only local host/origin requests, limits request size and request frequency, and bounds inference time. Images are untrusted content, never instructions to the model.

Wardrobe and saved looks live in IndexedDB in the browser profile. A local profile is organization, not authentication. Anyone with access to that browser profile can access its wardrobe. Browser data clearing or changing browser/origin can lose the wardrobe; export backups are essential. Backups contain clothing photos and should be stored privately. AI runs on this computer without an API key or per-photo fee; initial model installation requires an internet download and consumes disk space. CPU processing can be slow.

This implementation is intentionally bound to localhost. The public deployment flag disables analysis rather than expose an unauthenticated personal-photo endpoint. These controls are appropriate for a local beta, not a replacement for public-service authentication, storage isolation, quotas or operational security.

## Evaluation and release gates

Automated domain tests check owned-only complete combinations, missing slots, availability/review/weather exclusions, formal constraints, dress alternatives, cold layers, variation, detection bounds and safe backup restoration. Browser tests cover desktop and mobile wardrobe creation/edit/reload, outfit saving and snapshot independence, formal failure states, backup restoration, controlled upload review, focus and overflow. Controlled upload tests mock the model and do not measure vision accuracy. Live-model scripts and JSON evidence are separate under `docs/verification`.

Before a public production release, use a consented, labelled apparel set covering single items, multiple separated items, worn garments, racks, clutter, low light, similar colors, patterns, diverse categories and no-clothing photos. Measure item precision/recall, category/color accuracy, crop overlap, false additions, correction time, duplicate behavior, latency percentiles and errors across target hardware. Set explicit release thresholds before collecting results, not after. A couple of public fixture images are smoke tests, not an accuracy benchmark.

Consumer validation should measure time to first useful outfit, upload abandonment, correction rate, repeats and whether people actually wear the recommendations. Test constrained cases: too few garments, laundry exclusions, formal event without formal shoes, heat/cold with unknown warmth, storage denial, interrupted inference and restore corruption. Expand the styling model only after these basics work.

Public release still requires account authentication, per-user storage isolation, an explicit consent/retention/deletion policy, encrypted storage and transport, abuse controls, observable background jobs, retries and idempotency, resource planning, backup/recovery exercises, accessibility review, and real-device performance tests. The free local mode can be shipped separately as an installable personal beta; it does not require a cloud service or paid API. Packaging, signed installer, upgrade/migration and support procedures remain work before a general desktop release.

## Recommended next product increments

After recognition evaluation: multi-photo batch upload with a review queue, automatic near-duplicate suggestions, learned outfit feedback and wear rotation, laundry availability, and optional weather location consent. Do not front-load account setup, body photographs, shopping or measurements into the initial wardrobe upload. The core product earns trust by identifying visible clothing, making corrections easy and recommending only items the person actually has.

