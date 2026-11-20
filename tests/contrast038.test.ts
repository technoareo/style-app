import assert from "node:assert/strict";
import test from "node:test";

const rgb = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const luminance = (hex: string) =>
  rgb(hex)
    .map((v) => v / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (a: string, b: string) => {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

test("Build 1 light and dark text tokens meet WCAG AA", () => {
  for (const [name, foreground, background, minimum] of [
    ["light ink", "#241d22", "#f8f5f0", 4.5],
    ["light muted", "#756d73", "#f8f5f0", 4.5],
    ["light plum button", "#ffffff", "#5b294d", 4.5],
    ["dark ink", "#f6eff3", "#171316", 4.5],
    ["dark muted", "#b8adb4", "#171316", 4.5],
    ["dark plum button", "#1c1319", "#c98dbb", 4.5],
  ] as const)
    assert.ok(contrast(foreground, background) >= minimum, `${name}: ${contrast(foreground, background)}`);
});
