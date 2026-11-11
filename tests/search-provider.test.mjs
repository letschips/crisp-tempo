// Tasks offered to Crisp Search (0.18.0, Crisp Search 0.8.0's provider contract). Failure modes:
// - canceled tasks are listed; finished ones crowd out open work or flood the list;
// - a subtask cannot be told from another with the same title (no parent shown);
// - the row gives no hint of when the task is due, or still counts down after it is done;
// - notes and the next step cannot be searched;
// - Crisp Search is absent, older, or loads after Tempo, and Tempo throws or never registers;
// - a reload of Tempo leaves a dead provider behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "tempo-search-"));
const stub = path.join(outDir, "obsidian-stub.mjs");
writeFileSync(stub, "export const getLanguage = () => 'zh';\n");
await esbuild.build({
  entryPoints: [path.join(root, "src/services/search-provider.ts")], bundle: true, format: "esm", platform: "node",
  outfile: path.join(outDir, "provider.mjs"), logLevel: "error", alias: { obsidian: stub },
});
const { searchEntries, connectSearch, MAX_DONE_ENTRIES } = await import(pathToFileURL(path.join(outDir, "provider.mjs")).href);

const TODAY = "2026-11-11";
const base = { status: "todo", triage: "processed", availability: "anytime", priority: "none", createdAt: 1, updatedAt: 1, order: "a" };
const t = (id, extra = {}) => ({ id, title: id, ...base, ...extra });
const db = (tasks) => ({ tasks: Object.fromEntries(tasks.map((x) => [x.id, x])), projects: { p1: { id: "p1", title: "ANKS" } } });

test("open tasks come first by due date, finished ones after, canceled never", () => {
  const entries = searchEntries(db([
    t("done-old", { status: "done", completedAt: 100 }),
    t("no-date", { updatedAt: 5 }),
    t("later", { dueDate: "2026-11-20" }),
    t("gone", { status: "canceled" }),
    t("overdue", { dueDate: "2026-11-09" }),
    t("done-new", { status: "done", completedAt: 200 }),
    t("waiting", { status: "waiting", dueDate: "2026-11-12" }),
  ]), TODAY, "zh");
  assert.deepEqual(entries.map((e) => e.id), ["overdue", "waiting", "later", "no-date", "done-new", "done-old"]);
  assert.deepEqual(entries.map((e) => e.done), [false, false, false, false, true, true]);
});

test("a row says which project, whose subtask and how long is left; finished rows say so instead", () => {
  const entries = searchEntries(db([
    t("parent", { title: "准备发布", projectId: "p1", dueDate: "2026-11-13" }),
    t("child", { title: "写更新说明", parentTaskId: "parent", nextStep: "先列要点", description: "对照 CHANGELOG" }),
    t("finished", { title: "已交付", status: "done", completedAt: 5, dueDate: "2026-11-09", projectId: "p1" }),
    t("wait", { title: "等回复", status: "waiting" }),
  ]), TODAY, "zh");
  const by = Object.fromEntries(entries.map((e) => [e.id, e]));
  assert.equal(by.parent.accessory, "ANKS · 还剩 2 天");
  assert.equal(by.child.subtitle, "准备发布");
  assert.equal(by.child.text, "先列要点\n对照 CHANGELOG");
  assert.equal(by.child.accessory, undefined);
  assert.equal(by.finished.accessory, "ANKS · 已完成");
  assert.equal(by.wait.accessory, "等待中");
  assert.equal(searchEntries(db([t("x", { dueDate: "2026-11-11" })]), TODAY, "en")[0].accessory, "Due today");
});

test("finished tasks are capped so years of history do not bury the list", () => {
  const many = Array.from({ length: MAX_DONE_ENTRIES + 40 }, (_, i) => t(`d${i}`, { status: "done", completedAt: i }));
  const entries = searchEntries(db([...many, t("open")]), TODAY, "zh");
  assert.equal(entries.length, MAX_DONE_ENTRIES + 1);
  assert.equal(entries[0].id, "open");
  assert.equal(entries[1].id, `d${MAX_DONE_ENTRIES + 39}`, "the most recently finished are kept");
});

test("Tempo registers with Crisp Search when it is there, again when it reloads, and never throws", () => {
  const provider = { id: "crisp-tempo", label: "任务", list: () => [], open() {} };
  const appWith = (search) => ({ plugins: { plugins: search ? { "crisp-search": search } : {} } });
  assert.equal(connectSearch(appWith(null), provider, null), null, "no Crisp Search");
  assert.equal(connectSearch(appWith({ searchProviderApiVersion: 0, registerSearchProvider() {} }), provider, null), null, "older contract");
  assert.equal(connectSearch(appWith({ searchProviderApiVersion: 1, registerSearchProvider() { throw new Error("boom"); } }), provider, null), null);
  assert.equal(connectSearch({}, provider, null), null);

  const registered = [];
  let removed = 0;
  const search = { searchProviderApiVersion: 1, registerSearchProvider(p) { registered.push(p); return () => removed++; } };
  const off = connectSearch(appWith(search), provider, null);
  assert.equal(registered[0], provider);
  const offAgain = connectSearch(appWith(search), provider, off);
  assert.equal(removed, 1, "the earlier registration is dropped before registering again");
  offAgain();
  assert.equal(removed, 2);
});
