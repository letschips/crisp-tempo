// 界面语言测试：默认跟随 Obsidian 的界面语言，也可以在设置里固定中文或英文。
// 失败模式：英文 Obsidian 下新装仍是中文；老用户手动选过的英文被改回去；固定的语言被 Obsidian 覆盖；
// 授权报错在英文界面仍是中文；切换语言后任务数据被改动；英文计数出现「1 tasks」；英文文案里混进中文；
// 繁体 Obsidian 下跟随时仍显示简体、固定简体却变成繁体、繁体被存进数据；改了中文文案没重新生成繁体表。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
  `export { t, tf, lt, translations } from ${JSON.stringify(path.join(root, "src/services/i18n.ts"))};`,
  `export { toHant } from ${JSON.stringify(path.join(root, "src/services/hant.ts"))};`,
].join("\n"));
await esbuild.build({
  entryPoints: [entry], bundle: true, format: "esm", platform: "node",
  outfile: path.join(outDir, "store.mjs"), logLevel: "error", alias: { obsidian: stub },
});
globalThis.window = { app: { appId: "test-device" } };
const { TempoStore, createEmptyDatabase, verifyLicenseCode, t, tf, lt, translations, toHant } = await import(pathToFileURL(path.join(outDir, "store.mjs")).href);

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

test("英文计数按单复数显示，中文不受影响", () => {
  assert.equal(tf("taskCount", "en", { n: 1 }), "1 task");
  assert.equal(tf("taskCount", "en", { n: 0 }), "0 tasks");
  assert.equal(tf("taskCount", "zh", { n: 1 }), "1 项");
  assert.equal(tf("confirmDelete", "en", { n: 1 }), "Confirm delete (1 item)");
  assert.equal(tf("confirmDeleteProject", "en", { n: 1 }), "Confirm delete (1 task leaves the project and is kept)");
  assert.equal(tf("confirmDeleteCycle", "en", { n: 3 }), "Confirm delete (3 tasks leave the cycle and are kept)");
  assert.match(tf("resetWarning", "en", { t: 1, p: 2, c: 1 }), /^Currently contains 1 task, 2 projects, 1 cycle\./);
});

test("英文词典不含中文（语言选项里的「简体中文」除外），也没有漏替换的占位符", () => {
  for (const [key, text] of Object.entries(translations.en)) {
    if (key === "languageZh") continue;
    assert.doesNotMatch(text, /[\u3400-\u9fff]/, key);
    assert.doesNotMatch(tf(key, "en", { n: 2, t: 2, p: 2, c: 2 }), /\{(n|t|p|c)\b/, key);
  }
});

test("繁体 Obsidian + 跟随：界面显示繁体，用台湾用语；数据里的语言设置不变", async () => {
  globalThis.__obsidianLanguage = "zh-TW";
  const { store, saved } = setup(existing({ language: "auto", locale: "zh" }));
  const data = await store.load();
  assert.equal(data.locale, "zh");
  assert.equal(t("settings", "zh"), "設定");
  assert.equal(t("projects", "zh"), "專案");
  assert.equal(tf("taskCount", "zh", { n: 2 }), "2 項");
  assert.equal(tf("licenseDevicesLimit", "zh", { n: 3 }), "3 台裝置");
  assert.equal(lt("本地签名校验通过", "x"), "本地簽名校驗通過");
  assert.equal((await verifyLicenseCode("", "crisp-tempo")).reason, "授權碼為空");
  await store.flush();
  assert.equal(saved().language, "auto");
  assert.equal(saved().locale, "zh");
});

test("繁体 Obsidian 下固定简体中文：保持简体", async () => {
  globalThis.__obsidianLanguage = "zh-TW";
  const { store } = setup(existing({ language: "zh", locale: "zh" }));
  await store.load();
  assert.equal(t("settings", "zh"), "设置");
  store.setLanguage("auto");
  assert.equal(t("settings", "zh"), "設定");
  store.setLanguage("zh");
  assert.equal(t("settings", "zh"), "设置");
});

test("繁体转换再转一次不变（文案里插值进来的内容可能已经转过）", () => {
  for (const text of Object.values(translations.zh)) assert.equal(toHant(toHant(text)), toHant(text), text);
});

test("繁体表和文案同步：改了中文文案要重跑 npm run hant", () => {
  const { fingerprint, readSources, BEGIN, END } = createRequire(import.meta.url)("../scripts/gen-hant.cjs");
  const source = readFileSync(path.join(root, "src/services/hant.ts"), "utf8");
  const table = JSON.parse(source.slice(source.indexOf(BEGIN) + BEGIN.length, source.indexOf(END)));
  assert.equal(table.fp, fingerprint(readSources()), "中文文案变了，繁体表没重新生成：npm run hant");
});
