// The Reminders and Calendar controller (src/services/apple-sync.ts) with the real store, planner and
// merge; only the EventKit helper is replaced by a fake that keeps reminders in memory and honours
// "expect" like the Swift helper. Scenarios from the 0.11.0 audit (crisp-tempo-audit-20261028):
// - F1: add to Reminders → unlink → next sync imports the reminder again as a second task;
// - F3: turning Reminders off while a sync is reading still writes to Reminders;
// - F4: a phone edit made between reading and writing is overwritten;
// - F5: a failed Calendar refresh leaves old events looking current;
// - F6: unchecking every list, then turning Reminders off and on, picks the default list again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "tempo-apple-ctl-"));
writeFileSync(path.join(outDir, "obsidian.mjs"), [
  "export const normalizePath = (p) => p;",
  "export const requestUrl = async () => ({ status: 503, json: {} });",
  "export class Notice { constructor(m) { (globalThis.notices ??= []).push(String(m)); } }",
].join("\n"));
writeFileSync(path.join(outDir, "helper.mjs"), [
  "export class AppleHelperError extends Error { constructor(code, message) { super(message); this.code = code; } }",
  "export const appleHelperSupported = () => true;",
  "export const runAppleHelper = (plugin, command, request) => globalThis.helper(command, request);",
].join("\n"));
await esbuild.build({
  stdin: {
    contents: [
      `export { TempoStore } from ${JSON.stringify(path.join(root, "src/core/store.ts"))};`,
      `export { AppleSyncController } from ${JSON.stringify(path.join(root, "src/services/apple-sync.ts"))};`,
    ].join("\n"),
    resolveDir: root, loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", outfile: path.join(outDir, "ctl.mjs"), logLevel: "error",
  alias: { obsidian: path.join(outDir, "obsidian.mjs") },
  plugins: [{ name: "fake-helper", setup(b) { b.onResolve({ filter: /^\.\/apple-helper$/ }, () => ({ path: path.join(outDir, "helper.mjs") })); } }],
});
globalThis.window = { setTimeout, clearTimeout, app: { appId: "test" } };
const { TempoStore, AppleSyncController } = await import(pathToFileURL(path.join(outDir, "ctl.mjs")).href);

const T0 = 1_760_000_000_000;
const task = (fields = {}) => ({
  id: "t1", title: "写周报", status: "todo", triage: "processed", availability: "anytime", priority: "none",
  createdAt: T0, updatedAt: T0, order: "a", ...fields,
});

/** Reminders kept in memory; apply-reminders checks "expect" against them like the Swift helper. */
function fakeReminders(initial = []) {
  const state = { reminders: new Map(initial.map((r) => [r.id, r])), writes: [], calls: [], hooks: {} };
  let seq = 0;
  const obj = (r) => ({ externalId: `EXT-${r.id}`, listId: "L1", listTitle: "收集箱", notes: "", due: null, completed: false, completedAt: null, modifiedAt: T0, ...r });
  globalThis.helper = async (command, request) => {
    state.calls.push(command);
    if (state.hooks[command]) await state.hooks[command](request);
    if (command === "status") return { reminders: "fullAccess", calendar: "fullAccess" };
    if (command === "reminder-lists") return { lists: [{ id: "L1", title: "收集箱" }, { id: "L2", title: "工作" }], defaultId: "L1" };
    if (command === "calendars") return { calendars: [] };
    if (command === "reminders") {
      const lists = new Set(request.lists);
      const open = [...state.reminders.values()].filter((r) => !r.completed && lists.has(obj(r).listId)).map(obj);
      const items = [];
      const missing = [];
      for (const item of request.items) {
        const r = state.reminders.get(item.id);
        if (r) items.push({ ...obj(r), requestedId: item.id });
        else missing.push(item.id);
      }
      return { reminders: open, items, missing };
    }
    if (command === "apply-reminders") {
      state.writes.push(request);
      const updates = (request.updates ?? []).map((u) => {
        const r = state.reminders.get(u.id);
        if (!r) return { ok: false, code: "missing" };
        const now = obj(r);
        const changed = Object.keys(u.expect ?? {}).filter((k) => (u.expect[k] ?? null) !== (now[k] ?? null));
        if (changed.length) return { ok: false, code: "changed", message: changed.join() };
        for (const k of ["title", "notes", "due", "completed"]) if (u[k] !== undefined) r[k] = u[k];
        r.modifiedAt = Date.now();
        return { ok: true, reminder: obj(r) };
      });
      const creates = (request.creates ?? []).map((c) => {
        const r = { id: `NEW-${++seq}`, title: c.title, notes: c.notes, due: c.due, listId: c.listId ?? "L1" };
        state.reminders.set(r.id, r);
        return { key: c.key, ok: true, reminder: obj(r) };
      });
      return { updates, creates };
    }
    if (command === "events") return state.hooks.eventsAnswer ? state.hooks.eventsAnswer() : { events: [] };
    throw new Error(`unexpected ${command}`);
  };
  return state;
}

function setup({ tasks = [task()], apple = {} } = {}) {
  const plugin = {
    app: { workspace: { trigger() {} } },
    register() {}, registerInterval() {}, registerDomEvent() {}, manifest: { dir: "x" },
  };
  const store = TempoStore.get(plugin);
  store.status = "ready";
  store.saveDebounced = () => {};
  store.data = {
    schemaVersion: 1, locale: "zh", licenseStatus: "valid",
    database: { schemaVersion: 1, tasks: Object.fromEntries(tasks.map((t) => [t.id, t])), projects: {}, cycles: {}, areas: {}, labels: {} },
    apple: { remindersEnabled: true, reminderLists: ["L1"], ...apple },
  };
  store.setAppleRuntime({ available: true, reminders: "fullAccess", calendar: "fullAccess", defaultListId: "L1" });
  const controller = new AppleSyncController(plugin);
  return { store, controller };
}
const linkOf = (id, fields = {}) => ({ id, externalId: `EXT-${id}`, listId: "L1", title: "写周报", notes: "", due: null, completed: false, ...fields });

test("F1: add to Reminders, unlink, sync again: still one task, and the reminder is left alone", async () => {
  const fake = fakeReminders();
  const { store, controller } = setup();
  await controller.sendTask("t1");
  assert.equal(store.data.apple.links.t1.id, "NEW-1");
  controller.unlinkTask("t1");
  await controller.syncNow();
  await controller.syncNow();
  assert.deepEqual(Object.keys(store.data.database.tasks), ["t1"]);
  assert.equal(store.data.apple.links.t1.off, true);
  // Adding it again links the same reminder again (see "F1 again" below).
  await controller.sendTask("t1");
  assert.equal(store.data.apple.links.t1.off, undefined);
  assert.equal(fake.reminders.size, 1);
});

test("F3: turning Reminders off while a sync reads writes nothing to Reminders or Tempo", async () => {
  const fake = fakeReminders([{ id: "R1", title: "写周报", listId: "L1" }]);
  const { store, controller } = setup({ tasks: [task({ title: "Tempo 改了", updatedAt: T0 + 1 })], apple: { links: { t1: linkOf("R1") } } });
  let release;
  const reading = new Promise((resolve) => { fake.hooks.reminders = () => new Promise((r) => { release = r; resolve(); }); });
  const run = controller.syncNow();
  await reading;
  await controller.setEnabled("reminders", false);
  release();
  await run;
  assert.equal(fake.writes.length, 0);
  assert.equal(fake.reminders.get("R1").title, "写周报");
});

test("F4: a phone edit between reading and writing is kept, then merged on the next sync", async () => {
  const fake = fakeReminders([{ id: "R1", title: "写周报", listId: "L1" }]);
  const { store, controller } = setup({ tasks: [task({ title: "Tempo 改了", updatedAt: T0 + 100 })], apple: { links: { t1: linkOf("R1") } } });
  let first = true;
  fake.hooks["apply-reminders"] = () => {
    if (!first) return;
    first = false;
    const r = fake.reminders.get("R1");
    r.title = "手机上后改的";
    r.modifiedAt = Date.now();
  };
  await controller.syncNow();
  await controller.syncNow();
  assert.equal(fake.reminders.get("R1").title, "手机上后改的", "not overwritten");
  assert.equal(store.data.database.tasks.t1.title, "手机上后改的", "the later edit reaches Tempo");
  assert.equal(store.data.apple.links.t1.title, "手机上后改的");
  assert.ok(fake.writes[0].updates[0].expect.title === "写周报", "the write says what it was planned against");
});

test("F5: a failed Calendar refresh keeps the old events but marks them as not current", async () => {
  const fake = fakeReminders();
  const { store, controller } = setup({ apple: { remindersEnabled: false, calendarEnabled: true } });
  fake.hooks.eventsAnswer = () => ({ events: [{ id: "e1", title: "会", start: Date.now(), end: Date.now() + 3600e3, allDay: false }] });
  await controller.syncNow();
  assert.equal(store.appleRuntime.events.length, 1);
  assert.equal(store.appleRuntime.eventsError, undefined);
  fake.hooks.eventsAnswer = () => { throw new Error("timeout"); };
  await controller.syncNow();
  assert.equal(store.appleRuntime.events.length, 1);
  assert.match(store.appleRuntime.eventsError, /timeout/);
  fake.hooks.eventsAnswer = () => ({ events: [] });
  await controller.syncNow();
  assert.equal(store.appleRuntime.eventsError, undefined);
  assert.equal(store.appleRuntime.events.length, 0);
});

test("F6: no list chosen stays no list after turning Reminders off and on; a first start picks the default", async () => {
  fakeReminders([{ id: "R9", title: "收集箱里的", listId: "L1" }]);
  const { store, controller } = setup();
  store.updateAppleSettings((prev) => ({ ...prev, reminderLists: [] }));
  await controller.setEnabled("reminders", false);
  await controller.setEnabled("reminders", true);
  assert.deepEqual(store.data.apple.reminderLists, []);
  assert.equal(Object.keys(store.data.database.tasks).length, 1, "nothing imported");

  const fresh = setup({ apple: { remindersEnabled: false, reminderLists: undefined } });
  delete fresh.store.data.apple.reminderLists;
  await fresh.controller.setEnabled("reminders", true);
  assert.deepEqual(fresh.store.data.apple.reminderLists, ["L1"]);
});

test("auto-add: a new task is added once; older ones, a deleted reminder's task and failures are not re-sent", async () => {
  const fake = fakeReminders();
  const since = Date.now() - 1000;
  const { store, controller } = setup({
    tasks: [task({ id: "old", createdAt: since - 5000 }), task({ id: "new", title: "新任务", createdAt: since + 10, dueDate: "2026-11-01" })],
    apple: { reminderLists: [], autoSend: true, autoSendSince: since },
  });
  await controller.syncNow();
  assert.equal(fake.reminders.size, 1);
  const [created] = fake.reminders.values();
  assert.equal(created.title, "新任务");
  assert.equal(created.due, "2026-11-01");
  assert.equal(store.data.apple.links.new.id, created.id);
  assert.equal(store.data.apple.links.old, undefined, "a task from before the switch stays out");

  await controller.syncNow();
  assert.equal(fake.reminders.size, 1, "not added twice");

  fake.reminders.delete(created.id);
  await controller.syncNow();
  await controller.syncNow();
  assert.equal(fake.reminders.size, 0, "deleting the reminder does not bring it back");
  assert.equal(store.data.apple.links.new.off, true);

  // A failed add is tried again on a later sync, and linked once it works.
  store.updateDatabase((db) => ({ ...db, tasks: { ...db.tasks, n2: task({ id: "n2", title: "第二个", createdAt: since + 20 }) } }), false);
  let fail = true;
  fake.hooks["apply-reminders"] = (req) => { if (fail && req.creates?.length) { fail = false; throw new Error("EventKit busy"); } };
  await controller.syncNow();
  assert.equal(store.data.apple.links.n2, undefined);
  assert.equal(store.appleRuntime.lastSync.ok, false);
  await controller.syncNow();
  assert.ok(store.data.apple.links.n2 && !store.data.apple.links.n2.off);
  assert.equal(fake.reminders.size, 1);
});

test("F1 again: unlink then add again relinks the open original, and a finished one is never imported again", async () => {
  const fake = fakeReminders();
  const { store, controller } = setup();
  await controller.sendTask("t1");
  const first = store.data.apple.links.t1.id;
  controller.unlinkTask("t1");
  await controller.sendTask("t1");
  assert.equal(fake.reminders.size, 1, "the original reminder is linked again, not duplicated");
  assert.equal(store.data.apple.links.t1.id, first);
  assert.equal(store.data.apple.links.t1.off, undefined);
  await controller.syncNow();
  assert.deepEqual(Object.keys(store.data.database.tasks), ["t1"]);

  // The original was finished while unlinked: adding again makes a new reminder, and reopening the
  // old one later does not import it as a second task.
  controller.unlinkTask("t1");
  fake.reminders.get(first).completed = true;
  await controller.sendTask("t1");
  assert.equal(fake.reminders.size, 2);
  assert.notEqual(store.data.apple.links.t1.id, first);
  assert.deepEqual(store.data.apple.ignored, [`EXT-${first}`]);
  fake.reminders.get(first).completed = false;
  await controller.syncNow();
  assert.deepEqual(Object.keys(store.data.database.tasks), ["t1"]);
});

test("F2: two tasks on one reminder are announced once and the newer one points at the older", async () => {
  fakeReminders([{ id: "R1", title: "写周报", listId: "L1" }]);
  globalThis.notices = [];
  const { store, controller } = setup({
    tasks: [task({ id: "a", createdAt: T0 }), task({ id: "b", createdAt: T0 + 1 })],
    apple: { links: { a: linkOf("R1"), b: { ...linkOf("R1-MAC2"), externalId: "EXT-R1" } } },
  });
  await controller.syncNow();
  await controller.syncNow();
  assert.equal(store.data.apple.links.b.duplicateOf, "a");
  assert.deepEqual(Object.keys(store.data.database.tasks).sort(), ["a", "b"], "no task is deleted");
  assert.equal(globalThis.notices.filter((n) => n.includes("同一条提醒")).length, 1);
});
