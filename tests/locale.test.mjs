// 界面语言测试：默认跟随 Obsidian 的界面语言，也可以在设置里固定中文或英文。
// 失败模式：英文 Obsidian 下新装仍是中文；老用户手动选过的英文被改回去；固定的语言被 Obsidian 覆盖；
// 授权报错在英文界面仍是中文；切换语言后任务数据被改动。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "tempo-locale-"));
const stub = path.join(outDir, "obsidian-stub.mjs");
writeFileSync(stub, [
  "export const normalizePath = (p) => p.replace(/\\\\/g, '/').replace(/\\/+/g, '/');",
  "export const requestUrl = () => Promise.reject(new Error('offline in test'));",
  "export const getLanguage = () => globalThis.__obsidianLanguage;",
].join("\n"));
const entry = path.join(outDir, "entry.ts");
writeFileSync(entry, [
  `export { TempoStore } from ${JSON.stringify(path.join(root, "src/core/store.ts"))};`,
  `export { createEmptyDatabase } from ${JSON.stringify(path.join(root, "src/core/mock-data.ts"))};`,
  `export { verifyLicenseCode } from ${JSON.stringify(path.join(root, "src/services/license.ts"))};`,
].join("\n"));
await esbuild.build({
  entryPoints: [entry], bundle: true, format: "esm", platform: "node",
  outfile: path.join(outDir, "store.mjs"), logLevel: "error", alias: { obsidian: stub },
});
globalThis.window = { app: { appId: "test-device" } };
const { TempoStore, createEmptyDatabase, verifyLicenseCode } = await import(pathToFileURL(path.join(outDir, "store.mjs")).href);

const DATA = ".obsidian/plugins/crisp-tempo/data.json";
function setup(disk) {
  const files = disk === undefined ? {} : { [DATA]: JSON.stringify(disk) };
  const adapter = {
    exists: async (p) => p in files,
    read: async (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]; },
    write: async (p, text) => { files[p] = text; },
    stat: async (p) => (p in files ? { size: Buffer.byteLength(files[p]) } : null),
    list: async () => ({ files: [], folders: [] }),
    remove: async (p) => { delete files[p]; },
  };
  const plugin = {
    manifest: { id: "crisp-tempo", dir: ".obsidian/plugins/crisp-tempo" },
    app: { plugins: { plugins: {} }, vault: { configDir: ".obsidian", adapter } },
    loadData: async () => (DATA in files ? JSON.parse(files[DATA]) : null),
    saveData: async (data) => { files[DATA] = JSON.stringify(data); },
  };
  return { store: new TempoStore(plugin), saved: () => JSON.parse(files[DATA]) };
}
const existing = (fields) => ({ schemaVersion: 1, database: createEmptyDatabase(), ...fields });

test("新装：英文 Obsidian 显示英文，设置为跟随 Obsidian", async () => {
  globalThis.__obsidianLanguage = "en";
  const { store } = setup(undefined);
  const data = await store.load();
  assert.equal(data.locale, "en");
  assert.equal(data.language, "auto");
});

test("新装：中文（含繁体）Obsidian 显示中文", async () => {
  for (const lang of ["zh", "zh-TW"]) {
    globalThis.__obsidianLanguage = lang;
    const { store } = setup(undefined);
    assert.equal((await store.load()).locale, "zh");
  }
});

test("老数据只有 locale: zh（从没选过）时改为跟随 Obsidian", async () => {
  globalThis.__obsidianLanguage = "en";
  const { store } = setup(existing({ locale: "zh" }));
  const data = await store.load();
  assert.equal(data.language, "auto");
  assert.equal(data.locale, "en");
});

test("老用户手动选过英文：保持英文，不被中文 Obsidian 覆盖", async () => {
  globalThis.__obsidianLanguage = "zh";
  const { store } = setup(existing({ locale: "en" }));
  const data = await store.load();
  assert.equal(data.language, "en");
  assert.equal(data.locale, "en");
});

test("固定为中文时不跟随英文 Obsidian；改回跟随后立即生效并存盘", async () => {
  globalThis.__obsidianLanguage = "en";
  const { store, saved } = setup(existing({ locale: "zh", language: "zh" }));
  assert.equal((await store.load()).locale, "zh");
  store.setLanguage("auto");
  assert.equal(store.data.locale, "en");
  await store.flush();
  assert.equal(saved().language, "auto");
});

test("切换语言不改动任务数据", async () => {
  globalThis.__obsidianLanguage = "zh";
  const db = createEmptyDatabase();
  const { store, saved } = setup(existing({ locale: "zh", database: db }));
  await store.load();
  store.setLanguage("en");
  await store.flush();
  assert.deepEqual(saved().database, JSON.parse(JSON.stringify(db)));
});

test("授权报错随界面语言显示", async () => {
  globalThis.__obsidianLanguage = "en";
  const { store } = setup(undefined);
  await store.load();
  assert.equal((await verifyLicenseCode("", "crisp-tempo")).reason, "License code is empty");
  store.setLanguage("zh");
  assert.equal((await verifyLicenseCode("", "crisp-tempo")).reason, "授权码为空");
});
