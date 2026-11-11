// Due-date countdown on task rows (0.15.0). Failure modes:
// - a daylight-saving change makes a day 23h/25h and the count is off by one;
// - month or year boundaries are counted wrong;
// - "today" or "tomorrow" fall through to "0 days left" / "1 days left";
// - English plural forms are wrong ("1 days overdue");
// - Traditional Chinese Obsidian still shows Simplified countdown text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "tempo-due-"));
const stub = path.join(outDir, "obsidian-stub.mjs");
writeFileSync(stub, "export const getLanguage = () => globalThis.__obsidianLanguage;\n");
const entry = path.join(outDir, "entry.ts");
writeFileSync(entry, [
  `export { daysUntil, DUE_SOON_DAYS } from ${JSON.stringify(path.join(root, "src/services/date-service.ts"))};`,
  `export { formatDueCountdown } from ${JSON.stringify(path.join(root, "src/services/due-countdown.ts"))};`,
].join("\n"));
await esbuild.build({
  entryPoints: [entry], bundle: true, format: "esm", platform: "node",
  outfile: path.join(outDir, "due.mjs"), logLevel: "error", alias: { obsidian: stub },
});
const { daysUntil, DUE_SOON_DAYS, formatDueCountdown } = await import(pathToFileURL(path.join(outDir, "due.mjs")).href);

test("daysUntil counts calendar days across month, year and DST boundaries", () => {
  assert.equal(daysUntil("2026-11-11", "2026-11-11"), 0);
  assert.equal(daysUntil("2026-11-12", "2026-11-11"), 1);
  assert.equal(daysUntil("2026-11-09", "2026-11-11"), -2);
  assert.equal(daysUntil("2026-12-01", "2026-11-30"), 1);
  assert.equal(daysUntil("2027-01-01", "2026-12-31"), 1);
  assert.equal(daysUntil("2028-03-01", "2028-02-28"), 2); // leap year
  assert.equal(daysUntil("2026-03-09", "2026-03-07"), 2); // US DST starts 03-08
  assert.equal(daysUntil("2026-11-02", "2026-10-31"), 2); // US DST ends 11-01
  assert.equal(daysUntil("2026-03-30", "2026-03-28"), 2); // EU DST starts 03-29
});

test("countdown labels: overdue, today, tomorrow, days left", () => {
  globalThis.__obsidianLanguage = "zh";
  assert.equal(formatDueCountdown(-2, "zh"), "逾期 2 天");
  assert.equal(formatDueCountdown(0, "zh"), "今天截止");
  assert.equal(formatDueCountdown(1, "zh"), "明天截止");
  assert.equal(formatDueCountdown(5, "zh"), "还剩 5 天");
  assert.equal(formatDueCountdown(-1, "en"), "1 day overdue");
  assert.equal(formatDueCountdown(-3, "en"), "3 days overdue");
  assert.equal(formatDueCountdown(0, "en"), "Due today");
  assert.equal(formatDueCountdown(1, "en"), "Due tomorrow");
  assert.equal(formatDueCountdown(2, "en"), "2 days left");
  assert.equal(DUE_SOON_DAYS, 3);
});

test("Traditional Chinese Obsidian shows Traditional countdown text", () => {
  globalThis.__obsidianLanguage = "zh-TW";
  assert.equal(formatDueCountdown(5, "zh"), "還剩 5 天");
  assert.equal(formatDueCountdown(1, "zh"), "明天截止");
  globalThis.__obsidianLanguage = "zh";
});
