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
// - a repeating reminder finished in Tempo comes back open with the next date and the completion is
//   lost; finished in Reminders, the task only moves to the next date and is never done (0.12.3);
// - a repeating reminder merely moved to a later day counts as finished.
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
  planReminderSync, confirmUpdate, cleanAppleSettings, busyMinutes, mergeAppleSettings, reminderSourceId, autoSendCandidates,
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
  assert.equal(gone.links.t1.off, true, "kept switched off so the task is not added to Reminders again");
  assert.equal(gone.unlinked, 1);
  assert.equal(plan({ tasks: [], items: [], missing: ["R1"] }).links.t1, undefined, "nothing to remember once the task is gone too");

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
  const undated = plan({ links: {}, reminders: [reminder({ id: "R5", externalId: "EXT-5", due: null })] });
  assert.equal(Object.values(undated.db.tasks).find((t) => t.sourceId === "apple-reminders:EXT-5").triage, "inbox",
    "no due day: lands in the inbox like any new task, not out of sight in Anytime");
  assert.equal(created.sourceId, "apple-reminders:EXT-2");
  assert.equal(result.links[created.id].externalId, "EXT-2");

  // Another Mac: same reminder, different local id.
  const otherMac = plan({ reminders: [{ ...fresh, id: "LOCAL-ON-MAC-2" }], links: result.links, tasks: Object.values(result.db.tasks) });
  assert.equal(otherMac.imported, 0);
  // Links lost in a merge, but the task with its source survived.
  const noLink = plan({ reminders: [fresh], links: {}, tasks: Object.values(result.db.tasks) });
  assert.equal(noLink.imported, 0);
});

test("without a due day an import follows Tempo's default destination", () => {
  const r = reminder({ id: "R6", externalId: "EXT-6", due: null });
  const today = planReminderSync({
    db: db([]), links: {}, fetched: { reminders: [r], items: [], missing: [] },
    now: T0, canImport: true, newTaskId: () => "x", dest: "today", today: "2026-10-28",
  }).db.tasks.x;
  assert.equal(today.triage, "processed");
  assert.equal(today.focusDate, "2026-10-28");
  const future = planReminderSync({
    db: db([]), links: {}, fetched: { reminders: [reminder({ id: "R7", externalId: "EXT-7", due: "2026-11-30" })], items: [], missing: [] },
    now: T0, canImport: true, newTaskId: () => "y", dest: "inbox",
  }).db.tasks.y;
  assert.equal(future.triage, "processed", "a dated reminder is placed by its date (Upcoming)");
  assert.equal(future.focusDate, undefined);
});

test("a reminder in the never-import set stays out, whatever its links say", () => {
  const r = reminder({ id: "R8", externalId: "EXT-8" });
  const result = planReminderSync({
    db: db([]), links: {}, fetched: { reminders: [r, reminder({ id: "L9", externalId: null })], items: [], missing: [] },
    now: T0, canImport: true, newTaskId: () => `n${++seq}`, ignored: ["EXT-8", "local:L9"],
  });
  assert.equal(result.imported, 0);
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
  assert.deepEqual(cleanAppleSettings({ ignored: ["EXT-1", 2], links: { t1: link({ off: true, duplicateOf: "t0" }), t2: link({ duplicateOf: "t0" }) } }),
    { ignored: ["EXT-1"], links: { t1: link({ off: true, duplicateOf: "t0" }), t2: link() } }, "duplicateOf only on a switched-off link");
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
  assert.deepEqual(mergeAppleSettings({}, { ignored: ["a"] }, { ignored: ["b", "a"] }, []).ignored, ["a", "b"], "never-import entries from both sides");
  const removed = mergeAppleSettings(base, { remindersEnabled: true }, base, []);
  assert.equal(removed.links, undefined, "a link removed on one side stays removed");
});

test("an unlinked task neither syncs nor comes back as a second task, also after its reminder is done", () => {
  const off = { t1: link({ off: true }) };
  const result = plan({
    tasks: [task({ title: "Tempo 改了", updatedAt: T0 + 9 })], links: off,
    items: [reminder({ title: "手机改了", modifiedAt: T0 + 5 })], reminders: [reminder({ title: "手机改了" })],
  });
  assert.deepEqual(result.updates, []);
  assert.equal(result.db.tasks.t1.title, "Tempo 改了");
  assert.equal(result.imported, 0);
  assert.equal(result.links.t1.off, true);
  assert.equal(plan({ links: off, items: [reminder({ completed: true })] }).links.t1.off, true);
  assert.equal(plan({ links: off, missing: ["R1"] }).links.t1.off, true);
  assert.equal(plan({ tasks: [], links: off, items: [reminder({ completed: true })] }).links.t1, undefined);
});

test("two tasks linked to one reminder (two Macs imported it at once): the oldest keeps it, nothing is deleted", () => {
  const a = task({ id: "a", createdAt: T0 + 2 });
  const b = task({ id: "b", createdAt: T0 + 1, title: "改过的" , updatedAt: T0 + 50 });
  const links = { a: link({ id: "MAC-A" }), b: link({ id: "MAC-B" }) };
  const result = plan({ tasks: [a, b], links, items: [reminder({ id: "MAC-A", requestedId: "MAC-A" }), reminder({ id: "MAC-A", requestedId: "MAC-B" })] });
  assert.equal(result.duplicates, 1);
  assert.equal(result.links.a.off, true, "the newer task's link is switched off");
  assert.equal(result.links.a.duplicateOf, "b", "and says which task holds the reminder");
  assert.equal(result.links.b.off, undefined);
  assert.deepEqual(Object.keys(result.db.tasks).sort(), ["a", "b"]);
  assert.deepEqual(result.updates.map((u) => u.taskId), ["b"], "only the kept task writes");
});

test("auto-add picks open top-level tasks created since it was turned on, never linked, not from Reminders", () => {
  const since = T0 + 100;
  const tasks = [
    task({ id: "old", createdAt: T0 }),
    task({ id: "new", createdAt: since + 1 }),
    task({ id: "sub", createdAt: since + 2, parentTaskId: "new" }),
    task({ id: "done", createdAt: since + 3, status: "done", completedAt: since + 4 }),
    task({ id: "imported", createdAt: since + 5, sourceId: "apple-reminders:EXT-9" }),
    task({ id: "unlinked", createdAt: since + 6 }),
    task({ id: "pulse", createdAt: since + 7, sourceId: "crisp-pulse:abc" }),
  ];
  const apple = { autoSend: true, autoSendSince: since, links: { unlinked: link({ off: true }) } };
  assert.deepEqual(autoSendCandidates(db(tasks), apple).map((t) => t.id), ["new", "pulse"]);
  assert.deepEqual(autoSendCandidates(db(tasks), { ...apple, autoSend: undefined }), []);
});

// A weekly reminder as Reminders leaves it after one occurrence is finished: the reminder itself moves
// to the next date and stays open, and a finished copy with the old date is added (doneOccurrences).
const weekly = (fields = {}) => reminder({
  due: "2026-11-06", recurring: true, modifiedAt: T0 + 5000,
  doneOccurrences: [{ due: "2026-10-30", completedAt: T0 + 5000 }], ...fields,
});

test("a repeating reminder finished in Reminders finishes the task and adds one for the next date", () => {
  const current = task({ dueDate: "2026-10-30", projectId: "p1", labels: ["l1"], estimateMinutes: 15, focusDate: "2026-10-30", sourceId: "apple-reminders:EXT-1" });
  const result = plan({ tasks: [current], links: { t1: link({ due: "2026-10-30" }) }, items: [weekly()] });
  const done = result.db.tasks.t1;
  assert.equal(done.status, "done");
  assert.equal(done.completedAt, T0 + 5000);
  assert.equal(done.dueDate, "2026-10-30", "the finished task keeps its own date");
  assert.equal(result.links.t1, undefined, "the finished task no longer syncs");
  const [nextId] = Object.keys(result.links);
  const next = result.db.tasks[nextId];
  assert.equal(next.status, "todo");
  assert.equal(next.dueDate, "2026-11-06");
  assert.equal(next.title, "写周报");
  assert.equal(next.projectId, "p1");
  assert.deepEqual(next.labels, ["l1"]);
  assert.equal(next.estimateMinutes, 15);
  assert.equal(next.focusDate, undefined, "planned for today was the finished occurrence");
  assert.equal(next.sourceId, "apple-reminders:EXT-1");
  assert.equal(done.sourceId, undefined, "one task per source");
  assert.equal(result.links[nextId].due, "2026-11-06");
  assert.equal(result.advanced, 1);
  assert.deepEqual(result.updates, []);
  const again = plan({ tasks: Object.values(result.db.tasks), links: result.links, items: [weekly({ requestedId: "R1" })] });
  assert.equal(again.advanced, 0);
  assert.equal(again.pulled, 0);
  assert.deepEqual(again.updates, []);
});

test("a repeating reminder finished in Tempo stays done once Reminders moves it on", () => {
  const finished = task({ dueDate: "2026-10-30", status: "done", completedAt: T0 + 3000, updatedAt: T0 + 3000 });
  const first = plan({ tasks: [finished], links: { t1: link({ due: "2026-10-30" }) }, items: [reminder({ due: "2026-10-30", recurring: true })] });
  assert.equal(first.updates[0].completed, true);
  // The helper wrote it; EventKit moved the reminder to the next date and added a finished copy.
  const links = { t1: confirmUpdate(first.links.t1, first.updates[0]) };
  const second = plan({ tasks: [finished], links, items: [weekly()] });
  assert.equal(second.db.tasks.t1.status, "done", "not reopened");
  assert.equal(second.db.tasks.t1.completedAt, T0 + 3000);
  const next = Object.values(second.db.tasks).find((t) => t.id !== "t1");
  assert.equal(next.status, "todo");
  assert.equal(next.dueDate, "2026-11-06");
  assert.deepEqual(second.updates, []);
});

test("a repeating reminder moved to a later day without being finished only moves the task", () => {
  const result = plan({
    tasks: [task({ dueDate: "2026-10-30" })], links: { t1: link({ due: "2026-10-30" }) },
    items: [weekly({ doneOccurrences: [{ due: "2026-10-23", completedAt: T0 }] })],
  });
  assert.equal(result.advanced, 0);
  assert.equal(result.db.tasks.t1.status, "todo");
  assert.equal(result.db.tasks.t1.dueDate, "2026-11-06");
  assert.deepEqual(Object.keys(result.db.tasks), ["t1"]);
});

test("a title changed in Tempo carries over to the next occurrence and is written back", () => {
  const renamed = task({ title: "写周报（新）", dueDate: "2026-10-30", updatedAt: T0 + 1 });
  const result = plan({ tasks: [renamed], links: { t1: link({ due: "2026-10-30" }) }, items: [weekly()] });
  const nextId = Object.keys(result.links)[0];
  assert.equal(result.db.tasks[nextId].title, "写周报（新）");
  assert.deepEqual(result.updates.map((u) => [u.taskId, u.title]), [[nextId, "写周报（新）"]]);
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
