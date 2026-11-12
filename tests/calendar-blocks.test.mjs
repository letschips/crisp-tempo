// Scheduling tasks in macOS Calendar (time blocks). The real controller, store, planner and merge; only the
// EventKit helper is a fake that keeps events in memory and honours "expect" like the Swift helper.
// Failure modes:
// - an unactivated Tempo schedules anyway;
// - scheduling twice makes a second event instead of moving the first;
// - the event is moved in Calendar (to another day) and the task stays on the old day, or a finished task moves;
// - a title edit on one side is lost, or a Calendar edit between reading and writing is overwritten;
// - deleting a task leaves its upcoming event behind, or deletes a past one (the record);
// - finishing a task deletes its event;
// - an event deleted in Calendar deletes or changes the task, or a failed read unschedules everything;
// - two devices' blocks are lost when data.json merges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "tempo-blocks-"));
writeFileSync(path.join(outDir, "obsidian.mjs"), [
  "export const normalizePath = (p) => p;",
  "export const requestUrl = async () => ({ status: 503, json: {} });",
  "export class Notice { constructor(m) { (globalThis.notices ??= []).push(String(m)); } }",
].join("\n"));
writeFileSync(path.join(outDir, "helper.mjs"), [
  "export class AppleHelperError extends Error { constructor(code, message) { super(message); this.code = code; } }",
  "export const appleHelperSupported = () => true;",
  "export const runAppleHelper = (plugin, command, request) => globalThis.helper(command, request);",
  "export const startAppleWatch = () => () => {};",
].join("\n"));
await esbuild.build({
  stdin: {
    contents: [
      `export { TempoStore } from ${JSON.stringify(path.join(root, "src/core/store.ts"))};`,
      `export { AppleSyncController } from ${JSON.stringify(path.join(root, "src/services/apple-sync.ts"))};`,
      `export { mergeAppleSettings } from ${JSON.stringify(path.join(root, "src/core/merge.ts"))};`,
      `export { localDay } from ${JSON.stringify(path.join(root, "src/core/calendar-blocks.ts"))};`,
      `export { getTodayString } from ${JSON.stringify(path.join(root, "src/services/date-service.ts"))};`,
    ].join("\n"),
    resolveDir: root, loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", outfile: path.join(outDir, "ctl.mjs"), logLevel: "error",
  alias: { obsidian: path.join(outDir, "obsidian.mjs") },
  plugins: [{ name: "fake-helper", setup(b) { b.onResolve({ filter: /^\.\/apple-helper$/ }, () => ({ path: path.join(outDir, "helper.mjs") })); } }],
});
globalThis.window = { setTimeout, clearTimeout, app: { appId: "test" } };
const { TempoStore, AppleSyncController, mergeAppleSettings, localDay, getTodayString } =
  await import(pathToFileURL(path.join(outDir, "ctl.mjs")).href);

const T0 = 1_760_000_000_000;
const HOUR = 3_600_000;
const today = getTodayString();
const at = (days, hour) => {
  const d = new Date(`${today}T00:00:00`);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, hour).getTime();
};
const task = (fields = {}) => ({
  id: "t1", title: "写周报", status: "todo", triage: "inbox", availability: "anytime", priority: "none",
  createdAt: T0, updatedAt: T0, order: "a", ...fields,
});

/** Events kept in memory; apply-events checks "expect" like the Swift helper. */
function fakeCalendar(initial = []) {
  const state = { events: new Map(initial.map((e) => [e.id, e])), calls: [], writes: [], calendars: [], hooks: {} };
  let seq = 0;
  const obj = (e) => ({ externalId: `EXT-${e.id}`, calendarId: "CAL-T", allDay: false, modifiedAt: T0, ...e });
  globalThis.helper = async (command, request) => {
    state.calls.push(command);
    if (state.hooks[command]) await state.hooks[command](request);
    if (command === "status") return { reminders: "notDetermined", calendar: "fullAccess" };
    if (command === "calendars") return { calendars: state.calendars };
    if (command === "events") return { events: [] };
    if (command === "block-calendar") {
      const found = state.calendars.find((c) => c.id === request.calendarId) ?? state.calendars.find((c) => c.title === request.title);
      if (found) return { calendar: found, created: false };
      const made = { id: "CAL-T", title: request.title, writable: true };
      state.calendars.push(made);
      return { calendar: made, created: true };
    }
    if (command === "event-items") {
      const items = [];
      const missing = [];
      for (const item of request.items) {
        const e = state.events.get(item.id);
        if (e) items.push({ ...obj(e), requestedId: item.id });
        else missing.push(item.id);
      }
      return { items, missing };
    }
    if (command === "apply-events") {
      state.writes.push(request);
      const updates = (request.updates ?? []).map((u) => {
        const e = state.events.get(u.id);
        if (!e) return { ok: false, code: "missing" };
        const now = obj(e);
        const changed = Object.keys(u.expect ?? {}).filter((k) => u.expect[k] !== now[k]);
        if (changed.length) return { ok: false, code: "changed", message: changed.join() };
        if (u.title !== undefined) e.title = u.title;
        if (u.start !== undefined && u.end !== undefined) Object.assign(e, { start: u.start, end: u.end });
        e.modifiedAt = Date.now();
        return { ok: true, event: obj(e) };
      });
      const deletes = (request.deletes ?? []).map((d) => {
        state.events.delete(d.id);
        return { ok: true };
      });
      const creates = (request.creates ?? []).map((c) => {
        const e = { id: `EV-${++seq}`, title: c.title, start: c.start, end: c.end, calendarId: c.calendarId };
        state.events.set(e.id, e);
        return { key: c.key, ok: true, event: obj(e) };
      });
      return { updates, deletes, creates };
    }
    throw new Error(`unexpected ${command}`);
  };
  return state;
}

function setup({ tasks = [task()], apple = {}, licensed = true } = {}) {
  const plugin = {
    app: { workspace: { trigger() {} } },
    register() {}, registerInterval() {}, registerDomEvent() {}, manifest: { dir: "x" },
  };
  const store = TempoStore.get(plugin);
  store.status = "ready";
  store.saveDebounced = () => {};
  store.data = {
    schemaVersion: 1, locale: "zh", licenseStatus: licensed ? "valid" : "none",
    database: { schemaVersion: 1, tasks: Object.fromEntries(tasks.map((t) => [t.id, t])), projects: {}, cycles: {}, areas: {}, labels: {} },
    apple: { calendarEnabled: true, ...apple },
  };
  store.setAppleRuntime({ available: true, reminders: "notDetermined", calendar: "fullAccess" });
  return { store, controller: new AppleSyncController(plugin) };
}
const blockOf = (id, start, end, fields = {}) => ({ id, externalId: `EXT-${id}`, calendarId: "CAL-T", title: "写周报", start, end, ...fields });

test("without activation nothing is scheduled", async () => {
  const fake = fakeCalendar();
  const { store, controller } = setup({ licensed: false });
  assert.equal(await controller.scheduleTask("t1", at(1, 14), at(1, 15)), false);
  assert.equal(fake.calls.length, 0);
  assert.equal(store.data.apple.blocks, undefined);
});

test("scheduling makes the Tempo calendar and an event, moves the task to that day and fills a missing estimate", async () => {
  const fake = fakeCalendar();
  const { store, controller } = setup();
  assert.equal(await controller.scheduleTask("t1", at(2, 14), at(2, 15) + HOUR / 2), true);
  assert.equal(fake.calendars[0].title, "Tempo");
  const block = store.data.apple.blocks.t1;
  assert.equal(block.id, "EV-1");
  assert.equal(block.start, at(2, 14));
  const t1 = store.data.database.tasks.t1;
  assert.equal(t1.startDate, localDay(at(2, 14)));
  assert.equal(t1.triage, "processed");
  assert.equal(t1.estimateMinutes, 90);

  // Scheduled again: the same event moves, no second one; today puts the task in Today.
  await controller.scheduleTask("t1", at(0, 22), at(0, 23));
  assert.equal(fake.events.size, 1);
  assert.equal(fake.events.get("EV-1").start, at(0, 22));
  assert.equal(store.data.database.tasks.t1.focusDate, today);
  assert.equal(store.data.database.tasks.t1.startDate, undefined);
  assert.equal(store.data.database.tasks.t1.estimateMinutes, 90, "an estimate is never overwritten");
});

test("an event moved in Calendar to another day moves the task; a finished task stays", async () => {
  const fake = fakeCalendar([{ id: "E1", title: "写周报", start: at(0, 20), end: at(0, 21) }]);
  const { store, controller } = setup({
    tasks: [task({ triage: "processed", focusDate: today }), task({ id: "t2", title: "做完了", status: "done", completedAt: T0, triage: "processed" })],
    apple: { blocks: { t1: blockOf("E1", at(0, 20), at(0, 21)), t2: blockOf("E2", at(0, 9), at(0, 10), { title: "做完了" }) } },
  });
  fake.events.set("E2", { id: "E2", title: "做完了", start: at(0, 9), end: at(0, 10) });
  Object.assign(fake.events.get("E1"), { start: at(3, 10), end: at(3, 11) });
  Object.assign(fake.events.get("E2"), { start: at(4, 10), end: at(4, 11) });
  await controller.syncNow();
  const t1 = store.data.database.tasks.t1;
  assert.equal(t1.startDate, localDay(at(3, 10)));
  assert.equal(t1.focusDate, undefined);
  assert.equal(store.data.apple.blocks.t1.start, at(3, 10));
  assert.equal(store.data.database.tasks.t2.startDate, undefined);
  assert.equal(store.data.apple.blocks.t2.start, at(4, 10), "the link still follows the event");

  // Same day, other time: the task is not touched.
  const before = store.data.database.tasks.t1;
  Object.assign(fake.events.get("E1"), { start: at(3, 15), end: at(3, 16) });
  await controller.syncNow();
  assert.equal(store.data.database.tasks.t1, before);
});

test("titles sync both ways, and a Calendar edit between reading and writing is not overwritten", async () => {
  const fake = fakeCalendar([{ id: "E1", title: "写周报", start: at(1, 9), end: at(1, 10) }]);
  const { store, controller } = setup({
    tasks: [task({ title: "写周报（Tempo 改）", updatedAt: T0 + 5 })],
    apple: { blocks: { t1: blockOf("E1", at(1, 9), at(1, 10)) } },
  });
  let first = true;
  fake.hooks["apply-events"] = () => {
    if (!first) return;
    first = false;
    Object.assign(fake.events.get("E1"), { title: "日历里后改的", modifiedAt: T0 + 10 });
  };
  await controller.syncNow();
  assert.equal(fake.events.get("E1").title, "日历里后改的", "not overwritten");
  assert.equal(fake.writes[0].updates[0].expect.title, "写周报");
  await controller.syncNow();
  assert.equal(store.data.database.tasks.t1.title, "日历里后改的", "the later edit reaches Tempo");
  assert.equal(store.data.apple.blocks.t1.title, "日历里后改的");
});

test("deleting a task removes its upcoming event but keeps a past one; finishing keeps it", async () => {
  const fake = fakeCalendar([
    { id: "E1", title: "写周报", start: at(1, 9), end: at(1, 10) },
    { id: "E2", title: "旧的", start: at(-1, 9), end: at(-1, 10) },
    { id: "E3", title: "完成", start: at(1, 11), end: at(1, 12) },
  ]);
  const { store, controller } = setup({
    tasks: [task({ id: "t3", title: "完成", status: "done", completedAt: T0 })],
    apple: { blocks: {
      t1: blockOf("E1", at(1, 9), at(1, 10)),
      t2: blockOf("E2", at(-1, 9), at(-1, 10), { title: "旧的" }),
      t3: blockOf("E3", at(1, 11), at(1, 12), { title: "完成" }),
    } },
  });
  await controller.syncNow();
  assert.equal(fake.events.has("E1"), false, "upcoming event of a deleted task is deleted");
  assert.equal(fake.events.has("E2"), true, "a past one stays");
  assert.equal(fake.events.has("E3"), true, "a finished task keeps its event");
  assert.deepEqual(Object.keys(store.data.apple.blocks), ["t3"]);
});

test("an event deleted in Calendar unschedules the task; a failed read keeps every block", async () => {
  const fake = fakeCalendar();
  const { store, controller } = setup({
    tasks: [task({ triage: "processed", startDate: localDay(at(2, 9)) })],
    apple: { blocks: { t1: blockOf("E1", at(2, 9), at(2, 10)) } },
  });
  fake.hooks["event-items"] = () => { throw new Error("timeout"); };
  await controller.syncNow();
  assert.ok(store.data.apple.blocks.t1);
  delete fake.hooks["event-items"];
  const before = store.data.database.tasks.t1;
  await controller.syncNow();
  assert.equal(store.data.apple.blocks, undefined);
  assert.equal(store.data.database.tasks.t1, before);
});

test("removing from Calendar deletes the event and leaves the task", async () => {
  const fake = fakeCalendar([{ id: "E1", title: "写周报", start: at(1, 9), end: at(1, 10) }]);
  const { store, controller } = setup({ apple: { blocks: { t1: blockOf("E1", at(1, 9), at(1, 10)) } } });
  await controller.unscheduleTask("t1");
  assert.equal(fake.events.size, 0);
  assert.equal(store.data.apple.blocks, undefined);
  assert.ok(store.data.database.tasks.t1);
});

test("blocks from two devices survive a data.json merge; a removed one stays removed", () => {
  const a = blockOf("E1", at(1, 9), at(1, 10));
  const b = blockOf("E2", at(1, 11), at(1, 12));
  const c = blockOf("E3", at(1, 13), at(1, 14));
  const merged = mergeAppleSettings(
    { blocks: { t3: c } },
    { blocks: { t1: a, t3: c }, blockCalendarId: "CAL-X" },
    { blocks: { t2: b } },
    [],
  );
  assert.deepEqual(Object.keys(merged.blocks).sort(), ["t1", "t2"]);
  assert.equal(merged.blockCalendarId, "CAL-X");
});
