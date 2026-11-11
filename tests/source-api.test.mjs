// The plugin's own source-task methods (0.17.0), run on the real plugin class and store against
// temporary files. Failure modes:
// - createTaskFromSource resolves before the dated task is on disk, or drops the date on the way;
// - rescheduleSourceTask changes memory but not the file, or writes when nothing changed;
// - a date the user edited in Tempo is overwritten after a reload;
// - callers cannot tell this Tempo understands due dates (sourceTasksApiVersion).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "tempo-source-api-"));
const stub = path.join(outDir, "obsidian-stub.mjs");
fs.writeFileSync(stub, `
export class Plugin { constructor(app, manifest) { this.app = app; this.manifest = manifest; }
  registerView() {} addRibbonIcon() {} addCommand() {} addSettingTab() {} register() {} registerEvent() {} registerDomEvent() {} registerInterval() {} }
export class TFile {} export class ItemView {} export class PluginSettingTab {} export class Setting {} export class Modal {}
export class Notice {} export class Menu {} export class FileSystemAdapter {}
export const Platform = { isMobile: false, isDesktop: true };
export const normalizePath = (p) => p; export const addIcon = () => {}; export const setIcon = () => {};
export const requestUrl = () => Promise.reject(new Error("offline in test"));
export const getLanguage = () => "zh";
`);
const helperStub = path.join(outDir, "helper-stub.mjs");
fs.writeFileSync(helperStub, 'export default "";\n');
const entry = path.join(outDir, "entry.ts");
fs.writeFileSync(entry, [
  `export { default as Tempo } from ${JSON.stringify(path.join(root, "src/main.ts"))};`,
  `export { TempoStore } from ${JSON.stringify(path.join(root, "src/core/store.ts"))};`,
].join("\n"));
await esbuild.build({
  entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: path.join(outDir, "plugin.mjs"),
  logLevel: "error", jsx: "automatic", jsxImportSource: "preact",
  alias: { obsidian: stub, "tempo-apple-helper": helperStub },
  nodePaths: [path.join(root, "node_modules")],
});
globalThis.window = Object.assign(globalThis.window ?? {}, { setTimeout, clearTimeout, setInterval, clearInterval, app: { appId: "test-device" } });
globalThis.document ??= { hidden: false };
const { Tempo, TempoStore } = await import(pathToFileURL(path.join(outDir, "plugin.mjs")).href);

const SOURCE = "crisp-launchpad:publish-WECHAT-20261111-DEMO";
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tempo-vault-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const abs = (p) => path.join(dir, p);
  const dataPath = "plugin/tempo/data.json";
  fs.mkdirSync(path.dirname(abs(dataPath)), { recursive: true });
  fs.writeFileSync(abs(dataPath), JSON.stringify({ schemaVersion: 1, locale: "zh", defaultDest: "inbox", database: { schemaVersion: 1, tasks: {}, projects: {}, areas: {}, cycles: {}, labels: {} } }));
  let writes = 0;
  const adapter = {
    exists: async (p) => fs.existsSync(abs(p)),
    read: async (p) => fs.readFileSync(abs(p), "utf8"),
    write: async (p, c) => { if (p === dataPath) writes++; fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); },
    stat: async (p) => (fs.existsSync(abs(p)) ? { size: fs.statSync(abs(p)).size, mtime: 0, ctime: 0, type: "file" } : null),
    mkdir: async (p) => fs.mkdirSync(abs(p), { recursive: true }),
    list: async (p) => ({ files: fs.existsSync(abs(p)) ? fs.readdirSync(abs(p)).map((n) => `${p}/${n}`) : [], folders: [] }),
    remove: async (p) => fs.rmSync(abs(p), { force: true }),
    copy: async (a, b) => fs.copyFileSync(abs(a), abs(b)),
  };
  const app = {
    plugins: { plugins: {} },
    workspace: { trigger() {}, getLeavesOfType: () => [], on: () => ({}), onLayoutReady: (fn) => fn() },
    metadataCache: { getFileCache: () => null, getFirstLinkpathDest: () => null },
    vault: { adapter, configDir: ".obsidian", getAbstractFileByPath: () => null },
  };
  const start = async () => {
    const tempo = new Tempo(app, { id: "crisp-tempo", dir: "plugin/tempo", version: "0.17.0" });
    tempo.activateView = async () => null;
    await tempo.onload();
    const store = TempoStore.get(tempo);
    await store.load(true);
    store.data.licenseStatus = "valid";
    return { tempo, store };
  };
  const saved = () => Object.values(JSON.parse(fs.readFileSync(abs(dataPath), "utf8")).database.tasks);
  return { start, saved, writes: () => writes };
}

test("a dated source task is on disk, scheduled, when createTaskFromSource resolves", async (t) => {
  const f = await setup(t);
  const { tempo } = await f.start();
  assert.equal(tempo.sourceTasksApiVersion, 2);
  const snap = await tempo.createTaskFromSource({ sourceId: SOURCE, title: "发布：Demo", notePath: "a/article.md", dueDate: "2026-11-20" });
  assert.equal(snap.dueDate, "2026-11-20");
  const [task] = f.saved();
  assert.equal(task.dueDate, "2026-11-20");
  assert.equal(task.triage, "processed");
  assert.equal(task.notePath, "a/article.md");
  const overview = await tempo.getActionOverview();
  assert.deepEqual(overview.tasks.map((x) => [x.sourceId, x.dueDate]), [[SOURCE, "2026-11-20"]]);
  await assert.rejects(() => tempo.createTaskFromSource({ sourceId: "crisp-launchpad:publish-OTHER", title: "x", dueDate: "2026-02-30" }), /截止日期/);
  assert.equal(f.saved().length, 1, "a refused date leaves no task behind");
});

test("a reschedule reaches the disk, respects a date edited in Tempo across a reload, and skips no-op writes", async (t) => {
  const f = await setup(t);
  let { tempo, store } = await f.start();
  const made = await tempo.createTaskFromSource({ sourceId: SOURCE, title: "发布：Demo", dueDate: "2026-11-20" });
  const moved = await tempo.rescheduleSourceTask({ sourceId: SOURCE, dueDate: "2026-11-25", ifDueDate: "2026-11-20" });
  assert.equal(moved.status, "updated");
  assert.equal(moved.task.dueDate, "2026-11-25");
  assert.equal(f.saved()[0].dueDate, "2026-11-25");

  // The user moves it in Tempo; after a reload a stale caller must not win.
  store.updateDatabase((db) => ({ ...db, tasks: { ...db.tasks, [made.id]: { ...db.tasks[made.id], dueDate: "2026-11-27" } } }));
  await store.flush();
  ({ tempo, store } = await f.start());
  const before = f.writes();
  const kept = await tempo.rescheduleSourceTask({ sourceId: SOURCE, dueDate: "2026-12-01", ifDueDate: "2026-11-25" });
  assert.equal(kept.status, "kept");
  assert.equal(kept.task.dueDate, "2026-11-27");
  assert.equal(f.saved()[0].dueDate, "2026-11-27");
  assert.equal(f.writes(), before, "nothing changed, nothing written");

  const cleared = await tempo.rescheduleSourceTask({ sourceId: SOURCE, dueDate: null, ifDueDate: "2026-11-27" });
  assert.equal(cleared.status, "updated");
  assert.equal("dueDate" in f.saved()[0], false);
  assert.deepEqual(await tempo.rescheduleSourceTask({ sourceId: "crisp-launchpad:publish-NONE", dueDate: null, ifDueDate: null }), { status: "missing" });
});
