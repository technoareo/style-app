# Build 018 local real-model probe (23 October 2026)

Read-only evaluation of the in-workspace Qwen3-VL Ollama models using `analyzePhoto` on three existing fixtures, before the follow-up review fixes. Ollama 0.40.3 ran on 127.0.0.1 with cloud disabled; `ollama ps` reported 100% CPU for the 4B model. These are development observations, not a held-out accuracy benchmark or launch approval.

| Model | Fixture | Wall time | Result | Limitation |
| --- | --- | ---: | --- | --- |
| qwen3-vl:4b-instruct | `public-shirt.jpg` | 109.225 s | One white graphic T-shirt, Tops; box roughly matched item. | Warning repeated prompt boilerplate instead of an actionable issue; no uncertain fields despite subjective fit. |
| qwen3-vl:4b-instruct | `public-hoodie.jpg` | 114.172 s | One black zip hoodie, category Tops. | Could reasonably be Outerwear for layering; warning again repeated boilerplate. |
| qwen3-vl:4b-instruct | `candidates/handmade-shoes.jpg` (CC0) | 132.101 s | One cream perforated shoe, Shoes; ignored the shoemaking last. | Photo shows a pair; model cropped only one shoe and gave 0.75 self-confidence with no uncertainty. |
| qwen3-vl:2b-instruct | `public-shirt.jpg` | 74.983 s | One white graphic T-shirt, Tops. | Returned self-confidence 1 while marking color, pattern, material and fit uncertain; warning was literal `none`. |

After the build 018 review repairs, real Ollama `qwen3-vl:4b-instruct` accepted the revised three-candidate schema for `public-shirt.jpg` and returned one white graphic T-shirt with a usable crop in 102.2 seconds. It left material, seasons and occasions empty, and returned 0.75 self-confidence with no uncertain fields. This proves schema compatibility for this one local run, not detection accuracy or capacity. The warning still repeated the prompt's printed-graphics instruction instead of identifying an issue.

The two public product photos are copyrighted evaluation fixtures already tracked in the repository; see `tests/fixtures/SOURCES.md`. They are not user-owned or consented launch-benchmark photos. The shoe fixture's CC0 provenance is documented in `tests/fixtures/candidates/SOURCES.md`. The model self-ratings are not calibrated. Current single-item results are too slow for a frictionless consumer flow on this CPU machine; response-time work and a representative, permissioned photo set remain launch gates.
