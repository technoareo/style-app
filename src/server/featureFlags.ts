export type PublicFeatureFlags = {
  captureV2: boolean;
  pwaCache: boolean;
};

function booleanFlag(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return false;
}

/** Server-owned flags. No secret or private configuration is exposed. */
export function publicFeatureFlags(
  env: Record<string, string | undefined> = process.env,
): PublicFeatureFlags {
  return {
    captureV2: booleanFlag(env.STYLE_CAPTURE_V2_ENABLED, false),
    pwaCache: booleanFlag(env.STYLE_PWA_CACHE_ENABLED, true),
  };
}
