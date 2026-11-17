/**
 * Import FIRST in any test that drives the real vision client or worker against
 * a mock model. Those tests pin OLLAMA_URL themselves but would otherwise
 * inherit model/queue settings from the launching shell. An invalid
 * VISION_MODEL, for example, makes every analysis fail fast as "unavailable"
 * without a request ever reaching the mock. Tests that need a value set it
 * themselves after this import.
 */
for (const name of [
  "VISION_MODEL",
  "VISION_PROMPT",
  "STYLE_ANALYSIS_MODE",
  "STYLE_ANALYSIS_ESTIMATE_MS",
  "STYLE_DAILY_ANALYSES",
  "STYLE_DAILY_ATTEMPTS",
  "STYLE_INFERENCE_TIMEOUT_MS",
  "STYLE_JOB_WATCH_MS",
  "STYLE_QUEUE_MAX_ACTIVE",
  "STYLE_REVIEW_BUDGET_MS",
])
  delete process.env[name];
