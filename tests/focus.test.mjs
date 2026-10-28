// Focus time on tasks (0.4.0, with Crisp Focus 1.7.0). The real src/services/focus-bridge.ts and
// src/core/store.ts against an in-memory vault and a fake Crisp Focus. Failure modes:
// - an interrupted session is dropped, or a stray minute-long start/stop is counted;
// - a break, another plugin's session or an older Focus event is recorded on a task;
// - one session is recorded twice (Focus re-emits, two Tempo views listen);
// - an undo of an unrelated edit wipes focus time recorded after it;
// - a damaged focus log blocks Tempo from loading, or survives as bad entries;
// - starting from a task on an older Focus silently starts an unbound session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "tempo-focus-"));
const stub = path.join(outDir, "obsidian-stub.mjs");
writeFileSync(stub, [
  "export const normalizePath = (p) => p.replace(/\\\\/g, '/').replace(/\\/+/g, '/');",
  "export const requestUrl = async () => ({ status: 503, json: {} });",
].join("\n"));
const entry = path.join(outDir, "entry.ts");
writeFileSync(entry, [
  `export { TempoStore } from ${JSON.stringify(path.join(root, "src/core/store.ts"))};`,
  `export { createEmptyDatabase } from ${JSON.stringify(path.join(root, "src/core/mock-data.ts"))};`,
  `export * from ${JSON.stringify(path.join(root, "src/services/focus-bridge.ts"))};`,
].join("\n"));
await esbuild.build({
  entryPoints: [entry], bundle: true, format: "esm", platform: "node",
  outfile: path.join(outDir, "focus.mjs"), logLevel: "error", alias: { obsidian: stub },
});
globalThis.window = { app: { appId: "test-device" } };
const {
  TempoStore, createEmptyDatabase, focusEntryFromEvent, addFocusEntry, cleanFocusLog, summarizeFocus,
  activeFocusFromSnapshot, focusPluginStatus, startFocusForTask, focusSessionLog, entriesFromSessionLog,
} = await import(pathToFileURL(path.join(outDir, "focus.mjs")).href);

const TASK = { source: "crisp-tempo", id: "task-1", title: "修复转写回链" };
const event = (fields = {}) => ({
  apiVersion: 2, type: "complete", id: "s-1", kind: "focus", phase: "focus", pomodoro: true, round: 1,
  plannedMinutes: 25, startedAt: 1_760_000_000_000, at: 1_760_001_500_000, completed: true,
  elapsedMs: 25 * 60000, task: TASK, ...fields,
});

test("a finished session counts its planned minutes and an interrupted one its real minutes", () => {
  assert.deepEqual(focusEntryFromEvent(event()), {
    taskId: "task-1",
    entry: { id: "s-1", startedAt: 1_760_000_000_000, endedAt: 1_760_001_500_000, minutes: 25, completed: true, pomodoro: true },
  });
  const stopped = focusEntryFromEvent(event({ type: "stop", completed: false, elapsedMs: 12.9 * 60000, pomodoro: false }));
  assert.equal(stopped.entry.minutes, 12);
  assert.equal(stopped.entry.completed, false);
  assert.equal(focusEntryFromEvent(event({ type: "stop", completed: false, elapsedMs: 59_000 })), null, "不足 1 分钟不记");
  assert.equal(focusEntryFromEvent(event({ plannedMinutes: 900 })).entry.minutes, 240);
});

test("only Tempo-bound focus endings from Focus API 2 become entries", () => {
  for (const e of [
    event({ type: "start" }), event({ type: "pause" }), event({ type: "skip" }),
    event({ kind: "break", phase: "short-break" }),
    event({ task: null }), event({ task: { ...TASK, source: "crisp-other" } }), event({ task: { ...TASK, id: "" } }),
    event({ apiVersion: 1 }), event({ id: 42 }), null, "complete",
  ]) assert.equal(focusEntryFromEvent(e), null, JSON.stringify(e));
});

test("the same session is recorded once, and a task keeps its latest 500 sessions", () => {
  const { entry } = focusEntryFromEvent(event());
  const once = addFocusEntry({}, "task-1", entry);
  assert.equal(addFocusEntry(once, "task-1", entry), once, "重复的会话不改日志");
  let log = {};
  for (let i = 0; i < 505; i++) log = addFocusEntry(log, "task-1", { ...entry, id: `s-${i}`, endedAt: entry.endedAt + i });
  assert.equal(log["task-1"].length, 500);
  assert.equal(log["task-1"][0].id, "s-5");
  assert.deepEqual(summarizeFocus([
    entry, { ...entry, id: "s-2", minutes: 12, completed: false },
  ]), { minutes: 37, completed: 1, interrupted: 1, sessions: 2, lastEndedAt: entry.endedAt });
  assert.deepEqual(summarizeFocus(undefined), { minutes: 0, completed: 0, interrupted: 0, sessions: 0, lastEndedAt: 0 });
});

test("a damaged focus log keeps its good entries and never blocks loading", () => {
  const good = focusEntryFromEvent(event()).entry;
  assert.deepEqual(cleanFocusLog("oops"), { log: {}, dropped: 1 });
  assert.deepEqual(cleanFocusLog({
    "task-1": [good, { ...good, id: "" }, { ...good, minutes: -1 }, { ...good, minutes: 241 }, "x"],
    "task-2": "not a list",
  }), { log: { "task-1": [good] }, dropped: 5 });
  assert.deepEqual(cleanFocusLog(undefined), { log: {}, dropped: 0 });
});

test("the running Tempo task is read from Focus's own snapshot", () => {
  const snap = (fields) => ({ status: "running", kind: "focus", waiting: false, task: TASK, ...fields });
  assert.deepEqual(activeFocusFromSnapshot(snap()), { taskId: "task-1", state: "running" });
  assert.deepEqual(activeFocusFromSnapshot(snap({ status: "paused" })), { taskId: "task-1", state: "paused" });
  assert.deepEqual(activeFocusFromSnapshot(snap({ kind: "break" })), { taskId: "task-1", state: "break" });
  assert.deepEqual(activeFocusFromSnapshot(snap({ status: "idle", kind: null, waiting: true })), { taskId: "task-1", state: "waiting" });
  assert.equal(activeFocusFromSnapshot(snap({ status: "idle", kind: null })), null);
  assert.equal(activeFocusFromSnapshot(snap({ task: { ...TASK, source: "crisp-other" } })), null);
  assert.equal(activeFocusFromSnapshot(null), null);
});

function fakeFocus({ version = 2, enabled = true, entitled = true } = {}) {
  const calls = [];
  const plugin = {
    focusApiVersion: version,
    startPomodoro: async (options) => { calls.push(["pomodoro", options]); return entitled ? {} : null; },
    startFocusSession: async (minutes, options) => { calls.push(["single", minutes, options]); return {}; },
    getPomodoroSnapshot: () => ({ status: "idle", entitled }),
  };
  const app = { plugins: { plugins: enabled ? { "crisp-focus": plugin } : {}, enabledPlugins: new Set(enabled ? ["crisp-focus"] : []) } };
  return { app, calls };
}

test("starting from a task binds it, and refuses on a missing or older Crisp Focus", async () => {
  assert.equal(focusPluginStatus(fakeFocus({ enabled: false }).app).status, "missing");
  assert.equal(focusPluginStatus(fakeFocus({ version: 1 }).app).status, "outdated");
  const { app, calls } = fakeFocus();
  assert.equal(focusPluginStatus(app).status, "ready");
  await startFocusForTask(app, { id: "task-1", title: "  修复转写回链\n " }, "pomodoro");
  await startFocusForTask(app, { id: "task-1", title: "修复转写回链" }, "single");
  assert.deepEqual(calls, [
    ["pomodoro", { task: TASK }],
    ["single", undefined, { task: TASK }],
  ]);
  await assert.rejects(startFocusForTask(fakeFocus({ version: 1 }).app, { id: "task-1", title: "x" }, "single"), /1\.7\.0/);
  assert.equal(await startFocusForTask(fakeFocus({ entitled: false }).app, { id: "task-1", title: "x" }, "pomodoro"), false, "番茄未激活时 Focus 自己提示，Tempo 不当成已开始");
});

const TEMPO_DATA = ".obsidian/plugins/crisp-tempo/data.json";
function setup(extra = {}) {
  const db = createEmptyDatabase();
  db.tasks["task-1"] = { id: "task-1", title: "修复转写回链", status: "todo", triage: "processed", availability: "anytime", priority: "none", createdAt: 1, updatedAt: 1, order: "a" };
  const files = { [TEMPO_DATA]: JSON.stringify({ schemaVersion: 1, locale: "zh", language: "zh", database: db, ...extra }) };
  const io = { failWrites: false };
  const adapter = {
    exists: async (p) => p in files || p === ".obsidian/plugins/crisp-tempo",
    read: async (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]; },
    write: async (p, text) => { if (io.failWrites && p === TEMPO_DATA) throw new Error("disk full"); files[p] = text; },
    stat: async (p) => (p in files ? { size: Buffer.byteLength(files[p]) } : null),
    list: async () => ({ files: Object.keys(files), folders: [] }),
    remove: async (p) => { delete files[p]; },
  };
  const plugin = {
    manifest: { id: "crisp-tempo", dir: ".obsidian/plugins/crisp-tempo" },
    app: { plugins: { plugins: {} }, vault: { configDir: ".obsidian", adapter } },
    loadData: async () => JSON.parse(files[TEMPO_DATA]),
    saveData: async (data) => { files[TEMPO_DATA] = JSON.stringify(data); },
  };
  return { store: new TempoStore(plugin), saved: () => JSON.parse(files[TEMPO_DATA]), io, plugin };
}

test("recorded focus time is saved, outlives an undo and is read back on reload", async () => {
  const { store, saved } = setup();
  await store.load();
  store.updateDatabase((db) => ({ ...db, tasks: { ...db.tasks, "task-1": { ...db.tasks["task-1"], title: "改过的标题" } } }));
  const { taskId, entry } = focusEntryFromEvent(event());
  assert.equal(await store.recordFocusEntry(taskId, entry), true);
  assert.equal(await store.recordFocusEntry(taskId, entry), false, "同一段只记一次");
  assert.equal(store.undo(), true);
  assert.equal(store.data.database.tasks["task-1"].title, "修复转写回链");
  assert.equal(store.focusLog["task-1"].length, 1, "撤销别的编辑不会带走专注记录");
  await store.flush();
  assert.equal(saved().focusLog["task-1"][0].minutes, 25);
  const again = setup({ focusLog: saved().focusLog });
  await again.store.load();
  assert.equal(summarizeFocus(again.store.focusLog["task-1"]).minutes, 25);
});

test("a damaged focus log on disk does not stop Tempo from loading its tasks", async () => {
  const { store } = setup({ focusLog: { "task-1": [{ id: "x" }] } });
  await store.load();
  assert.equal(store.status, "ready");
  assert.ok(store.data.database.tasks["task-1"]);
  assert.deepEqual(store.focusLog, {});
});

test("the running task is runtime state: it notifies views but is never saved", async () => {
  const { store, saved } = setup();
  await store.load();
  let notified = 0;
  store.subscribe(() => notified++);
  store.setActiveFocus({ taskId: "task-1", state: "running" });
  store.setActiveFocus({ taskId: "task-1", state: "running" });
  assert.equal(notified, 1, "状态没变不重绘");
  assert.deepEqual(store.activeFocus, { taskId: "task-1", state: "running" });
  store.setDefaultDest("today");
  await store.flush();
  assert.equal(saved().activeFocus, undefined);
});

/* Catching up from Crisp Focus's session log (Focus 1.9.0, focusApiVersion 3). Failure modes:
   - a session that ended while Tempo was off, reloading or failing to save is never recorded;
   - catching up records a session twice, or records breaks, misclicks and other plugins' sessions;
   - an older Focus, or one whose log throws, breaks Tempo instead of being skipped. */
test("the session log is read only from Focus API 3, and a failing Focus is skipped", () => {
  const app = (plugin) => ({ plugins: { plugins: { "crisp-focus": plugin }, enabledPlugins: new Set(["crisp-focus"]) } });
  assert.equal(focusSessionLog(app({ focusApiVersion: 2, getSessionLog: () => ({ sessions: [event()] }) })), null);
  assert.equal(focusSessionLog(app({ focusApiVersion: 3, getSessionLog: () => { throw new Error("reloading"); } })), null);
  assert.equal(focusSessionLog(app({ focusApiVersion: 3, getSessionLog: () => ({ sessions: "nope" }) })), null);
  assert.equal(focusSessionLog({ plugins: { plugins: {}, enabledPlugins: new Set() } }), null);
  assert.deepEqual(focusSessionLog(app({ focusApiVersion: 3, getSessionLog: () => ({ apiVersion: 3, sessions: [event({ seq: 1 })] }) })), [event({ seq: 1 })]);
});

test("sessions Tempo missed are recorded from Focus's log once, in one save", async () => {
  const { store, saved } = setup();
  await store.load();
  const live = focusEntryFromEvent(event({ apiVersion: 3, id: "s-1", seq: 1 }));
  await store.recordFocusEntry(live.taskId, live.entry);
  const log = [
    event({ apiVersion: 3, id: "s-1", seq: 1 }),
    event({ apiVersion: 3, id: "s-2", seq: 2, type: "stop", completed: false, elapsedMs: 9 * 60000 }),
    event({ apiVersion: 3, id: "s-3", seq: 3, task: { source: "other-plugin", id: "x", title: "x" } }),
    event({ apiVersion: 3, id: "s-4", seq: 4, kind: "break" }),
    event({ apiVersion: 3, id: "s-5", seq: 5, task: null }),
  ];
  const items = entriesFromSessionLog(log);
  assert.deepEqual(items.map((i) => i.entry.id), ["s-1", "s-2"]);
  assert.equal(await store.recordFocusEntries(items), 1, "only the missed session is new");
  assert.equal(await store.recordFocusEntries(items), 0, "catching up again adds nothing");
  assert.deepEqual(saved().focusLog["task-1"].map((e) => [e.id, e.minutes]), [["s-1", 25], ["s-2", 9]]);
});

test("a catch-up that fails to save throws, and the next start records it again", async () => {
  const { store, io, plugin } = setup();
  await store.load();
  io.failWrites = true;
  const items = entriesFromSessionLog([event({ apiVersion: 3, id: "s-9", seq: 9 })]);
  await assert.rejects(store.recordFocusEntries(items), /保存失败|failed to save/);
  io.failWrites = false;
  const fresh = new TempoStore(plugin);
  await fresh.load();
  assert.equal(fresh.focusLog["task-1"], undefined, "nothing reached the disk");
  assert.equal(await fresh.recordFocusEntries(items), 1);
});
