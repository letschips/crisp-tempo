// macOS Reminders and Calendar (0.11.0). The real src/core/apple-sync.ts and merge.ts. Failure modes:
// - a reminder finished on the phone stays open in Tempo, or a Tempo edit never reaches Reminders;
// - a write that Reminders normalises ping-pongs between the two sides forever;
// - both sides changed: the older edit wins, or an empty Reminders title blanks the task;
// - a deleted reminder deletes the task, or a task deleted in Tempo is imported again;
// - the same reminder is imported twice (second Mac with other local ids, or a merge);
// - tasks are created from Reminders without a licence;
// - two devices' links or settings are lost when data.json merges;
// - overlapping meetings are counted twice against the day, or free/canceled ones count at all;
// - an unlinked task's reminder comes back as a second task (audit F1);
// - two Macs importing the same reminder at once both keep syncing it (audit F2);
// - a write does not say what it was planned against, so a later phone edit is overwritten (audit F4);
// - "no list" is lost and becomes the default list again (audit F6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "tempo-apple-"));
const stub = path.join(outDir, "obsidian-stub.mjs");
writeFileSync(stub, "export const normalizePath = (p) => p;\nexport const requestUrl = async () => ({ status: 503, json: {} });\n");
await esbuild.build({
  stdin: {
    contents: [
      `export * from ${JSON.stringify(path.join(root, "src/core/apple-sync.ts"))};`,
      `export { mergeAppleSettings } from ${JSON.stringify(path.join(root, "src/core/merge.ts"))};`,
    ].join("\n"),
    resolveDir: root,
    loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", outfile: path.join(outDir, "apple.mjs"), logLevel: "error",
  alias: { obsidian: stub },
});
const {
  planReminderSync, confirmUpdate, cleanAppleSettings, busyMinutes, mergeAppleSettings, reminderSourceId,
} = await import(pathToFileURL(path.join(outDir, "apple.mjs")).href);

const T0 = 1_760_000_000_000;
const task = (fields = {}) => ({
  id: "t1", title: "写周报", status: "todo", triage: "processed", availability: "anytime", priority: "none",
  createdAt: T0, updatedAt: T0, order: "a", ...fields,
});
const reminder = (fields = {}) => ({
  id: "R1", externalId: "EXT-1", listId: "L1", listTitle: "工作", title: "写周报", notes: "", due: null,
  completed: false, completedAt: null, modifiedAt: T0, ...fields,
});
const link = (fields = {}) => ({ id: "R1", externalId: "EXT-1", listId: "L1", title: "写周报", notes: "", due: null, completed: false, ...fields });
const db = (tasks) => ({ schemaVersion: 1, tasks: Object.fromEntries(tasks.map((t) => [t.id, t])), projects: {}, cycles: {}, areas: {}, labels: {} });
let seq = 0;
const plan = ({ tasks = [task()], links = { t1: link() }, reminders = [], items = [], missing = [], canImport = true, now = T0 + 10_000 } = {}) =>
  planReminderSync({
    db: db(tasks), links, fetched: { reminders, items: items.map((r) => ({ requestedId: r.id, ...r })), missing },
    now, canImport, newTaskId: () => `new-${++seq}`,
  });

test("a reminder finished in Reminders finishes the task, and reopening it reopens the task", () => {
  const done = plan({ items: [reminder({ completed: true, completedAt: T0 + 5000, modifiedAt: T0 + 5000 })] });
  assert.equal(done.db.tasks.t1.status, "done");
  assert.equal(done.db.tasks.t1.completedAt, T0 + 5000);
  assert.equal(done.links.t1.completed, true);
  assert.deepEqual(done.updates, []);

  const reopened = plan({
    tasks: [task({ status: "done", completedAt: T0 + 5000 })],
    links: { t1: link({ completed: true }) },
    items: [reminder({ completed: false, modifiedAt: T0 + 9000 })],
  });
  assert.equal(reopened.db.tasks.t1.status, "todo");
  assert.equal(reopened.db.tasks.t1.completedAt, undefined);
});

test("a Tempo edit becomes an update, and once written nothing is left to do", () => {
  const edited = task({ title: "写周报（含数据）", dueDate: "2026-10-30", status: "done", completedAt: T0 + 1, updatedAt: T0 + 1 });
  const first = plan({ tasks: [edited], items: [reminder()] });
  assert.deepEqual(first.updates, [{
    taskId: "t1", id: "R1", externalId: "EXT-1", listId: "L1", title: "写周报（含数据）", due: "2026-10-30", completed: true,
    expect: { title: "写周报", due: null, completed: false },
  }]);
  assert.equal(first.db.tasks.t1, edited, "nothing pulled");
  const links = { t1: confirmUpdate(first.links.t1, first.updates[0]) };
  const second = plan({
    tasks: [edited], links,
    items: [reminder({ title: "写周报（含数据）", due: "2026-10-30", completed: true, modifiedAt: T0 + 20 })],
  });
  assert.deepEqual(second.updates, []);
  assert.equal(second.pulled, 0);
});

test("a canceled task completes its reminder; it is not reopened on the next sync", () => {
  const canceled = task({ status: "canceled", canceledAt: T0 + 1, updatedAt: T0 + 1 });
  const first = plan({ tasks: [canceled], items: [reminder()] });
  assert.equal(first.updates[0].completed, true);
  const links = { t1: confirmUpdate(first.links.t1, first.updates[0]) };
  const second = plan({ tasks: [canceled], links, items: [reminder({ completed: true, completedAt: T0 + 30, modifiedAt: T0 + 30 })] });
  assert.equal(second.db.tasks.t1.status, "canceled");
  assert.deepEqual(second.updates, []);
});

test("a value Reminders stores differently settles after one round instead of bouncing", () => {
  const edited = task({ description: "第一行\r\n第二行", updatedAt: T0 + 1 });
  const first = plan({ tasks: [edited], items: [reminder()] });
  const links = { t1: confirmUpdate(first.links.t1, first.updates[0]) };
  // Reminders gives the notes back with \n.
  const back = reminder({ notes: "第一行\n第二行", modifiedAt: T0 + 50 });
  const second = plan({ tasks: [edited], links, items: [back] });
  assert.deepEqual(second.updates, []);
  assert.equal(second.db.tasks.t1.description, "第一行\n第二行");
  const third = plan({ tasks: [second.db.tasks.t1], links: second.links, items: [back] });
  assert.deepEqual(third.updates, []);
  assert.equal(third.pulled, 0);
});

test("when both sides changed a field, the later edit wins; other fields merge", () => {
  const tempoLater = plan({
    tasks: [task({ title: "Tempo 改的", updatedAt: T0 + 9000 })],
    items: [reminder({ title: "手机改的", due: "2026-11-01", modifiedAt: T0 + 5000 })],
  });
  assert.equal(tempoLater.db.tasks.t1.title, "Tempo 改的");
  assert.equal(tempoLater.db.tasks.t1.dueDate, "2026-11-01", "only Reminders changed the due day");
  assert.equal(tempoLater.updates[0].title, "Tempo 改的");

  const appleLater = plan({
    tasks: [task({ title: "Tempo 改的", updatedAt: T0 + 5000 })],
    items: [reminder({ title: "手机改的", modifiedAt: T0 + 9000 })],
  });
  assert.equal(appleLater.db.tasks.t1.title, "手机改的");
  assert.deepEqual(appleLater.updates, []);
});

test("an empty title in Reminders never blanks the task", () => {
  const result = plan({ items: [reminder({ title: "   ", modifiedAt: T0 + 9000 })] });
  assert.equal(result.db.tasks.t1.title, "写周报");
  assert.equal(result.updates[0].title, "写周报");
});

test("a deleted reminder only unlinks; a task deleted in Tempo is not imported again", () => {
  const gone = plan({ items: [], missing: ["R1"] });
  assert.equal(gone.db.tasks.t1.title, "写周报");
  assert.equal(gone.links.t1, undefined);
  assert.equal(gone.unlinked, 1);

  const deleted = plan({ tasks: [], items: [reminder()], reminders: [reminder()] });
  assert.equal(deleted.imported, 0);
  assert.ok(deleted.links.t1, "the link holds the reminder back");
  const finished = plan({ tasks: [], items: [reminder({ completed: true })] });
  assert.equal(finished.links.t1, undefined, "nothing left to hold back once it is done");
});

test("a link not looked up this time (added during the fetch) is kept", () => {
  const result = plan({ items: [], missing: [] });
  assert.deepEqual(result.links.t1, link());
});

test("open reminders in chosen lists are imported once, also from a second Mac and after a merge", () => {
  const fresh = reminder({ id: "R2", externalId: "EXT-2", title: " 交 房租\n", notes: "工行", due: "2026-10-28" });
  const done = reminder({ id: "R3", externalId: "EXT-3", completed: true });
  const result = plan({ reminders: [fresh, done], items: [reminder()] });
  assert.equal(result.imported, 1);
  const created = Object.values(result.db.tasks).find((t) => t.id !== "t1");
  assert.equal(created.title, "交 房租");
  assert.equal(created.description, "工行");
  assert.equal(created.dueDate, "2026-10-28");
  assert.equal(created.triage, "processed", "due today, so it shows in Today");
  assert.equal(created.sourceId, "apple-reminders:EXT-2");
  assert.equal(result.links[created.id].externalId, "EXT-2");

  // Another Mac: same reminder, different local id.
  const otherMac = plan({ reminders: [{ ...fresh, id: "LOCAL-ON-MAC-2" }], links: result.links, tasks: Object.values(result.db.tasks) });
  assert.equal(otherMac.imported, 0);
  // Links lost in a merge, but the task with its source survived.
  const noLink = plan({ reminders: [fresh], links: {}, tasks: Object.values(result.db.tasks) });
  assert.equal(noLink.imported, 0);
});

test("nothing is imported without a licence, but linked tasks still sync", () => {
  const result = plan({
    canImport: false,
    reminders: [reminder({ id: "R2", externalId: "EXT-2" })],
    items: [reminder({ completed: true, modifiedAt: T0 + 1 })],
  });
  assert.equal(result.imported, 0);
  assert.equal(result.db.tasks.t1.status, "done");
});

test("source ids stay inside Tempo's source id format", () => {
  assert.match(reminderSourceId({ id: "x", externalId: "a/b:c d" }), /^[a-z0-9-]+:[A-Za-z0-9-]{1,128}$/);
  assert.equal(reminderSourceId({ id: "LOCAL", externalId: null }), "apple-reminders:LOCAL");
});

test("stored settings keep what is readable and drop broken links", () => {
  const clean = cleanAppleSettings({
    remindersEnabled: true, reminderLists: ["L1", 3], calendarEnabled: "yes",
    links: { t1: link(), t2: { id: "R9", title: "x" }, t3: link({ due: "tomorrow" }) },
  });
  assert.deepEqual(clean, { remindersEnabled: true, reminderLists: ["L1"], links: { t1: link() } });
  assert.deepEqual(cleanAppleSettings({ reminderLists: [], links: { t1: link({ off: true }) } }), { reminderLists: [], links: { t1: link({ off: true }) } },
    "an empty choice and a switched-off link survive saving");
  assert.equal(cleanAppleSettings({}), undefined);
  assert.equal(cleanAppleSettings("x"), undefined);
});

test("links from both devices survive a merge; a setting changed on one side is taken", () => {
  const conflicts = [];
  const base = { remindersEnabled: true, links: { t1: link() } };
  const local = { remindersEnabled: true, links: { t1: link({ completed: true }), t2: link({ id: "R2" }) } };
  const remote = { remindersEnabled: true, calendarEnabled: true, links: { t1: link(), t3: link({ id: "R3" }) } };
  const merged = mergeAppleSettings(base, local, remote, conflicts);
  assert.equal(merged.calendarEnabled, true);
  assert.deepEqual(Object.keys(merged.links).sort(), ["t1", "t2", "t3"]);
  assert.equal(merged.links.t1.completed, true);
  assert.deepEqual(conflicts, []);
  const removed = mergeAppleSettings(base, { remindersEnabled: true }, base, []);
  assert.equal(removed.links, undefined, "a link removed on one side stays removed");
});

test("an unlinked task neither syncs nor comes back as a second task; it is let go once the reminder is done", () => {
  const off = { t1: link({ off: true }) };
  const result = plan({
    tasks: [task({ title: "Tempo 改了", updatedAt: T0 + 9 })], links: off,
    items: [reminder({ title: "手机改了", modifiedAt: T0 + 5 })], reminders: [reminder({ title: "手机改了" })],
  });
  assert.deepEqual(result.updates, []);
  assert.equal(result.db.tasks.t1.title, "Tempo 改了");
  assert.equal(result.imported, 0);
  assert.equal(result.links.t1.off, true);
  assert.equal(plan({ links: off, items: [reminder({ completed: true })] }).links.t1, undefined);
  assert.equal(plan({ links: off, missing: ["R1"] }).links.t1, undefined);
});

test("two tasks linked to one reminder (two Macs imported it at once): the oldest keeps it, nothing is deleted", () => {
  const a = task({ id: "a", createdAt: T0 + 2 });
  const b = task({ id: "b", createdAt: T0 + 1, title: "改过的" , updatedAt: T0 + 50 });
  const links = { a: link({ id: "MAC-A" }), b: link({ id: "MAC-B" }) };
  const result = plan({ tasks: [a, b], links, items: [reminder({ id: "MAC-A", requestedId: "MAC-A" }), reminder({ id: "MAC-A", requestedId: "MAC-B" })] });
  assert.equal(result.duplicates, 1);
  assert.equal(result.links.a.off, true, "the newer task's link is switched off");
  assert.equal(result.links.b.off, undefined);
  assert.deepEqual(Object.keys(result.db.tasks).sort(), ["a", "b"]);
  assert.deepEqual(result.updates.map((u) => u.taskId), ["b"], "only the kept task writes");
});

test("busy minutes count overlaps once, clip to the day and skip all-day events", () => {
  const day = new Date("2026-10-28T00:00:00").getTime();
  const at = (h, m = 0) => day + (h * 60 + m) * 60000;
  const events = [
    { id: "a", title: "站会", start: at(9), end: at(10), allDay: false },
    { id: "b", title: "评审", start: at(9, 30), end: at(11), allDay: false },
    { id: "c", title: "假期", start: day, end: day + 86400000, allDay: true },
    { id: "d", title: "跨夜", start: at(23), end: at(25), allDay: false },
    { id: "e", title: "午饭（空闲）", start: at(12), end: at(13), allDay: false, availability: "free" },
    { id: "f", title: "取消的会", start: at(14), end: at(15), allDay: false, status: "canceled" },
  ];
  assert.equal(busyMinutes(events, day, day + 86400000), 120 + 60);
});
