// Tasks made by other plugins, with a due date (0.17.0; Crisp Launchpad sends a content project's
// planned publish date). Failure modes:
// - the due date is dropped at creation, or the task sits in the inbox and never reaches Upcoming;
// - a malformed date is stored (Tempo then refuses the whole database on the next load);
// - asking again for the same source rewrites a date the user has since changed in Tempo;
// - a reschedule overwrites the user's own date, touches a finished task, or reports a task that is gone;
// - clearing the date removes one the user set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "tempo-source-"));
const stub = path.join(outDir, "obsidian-stub.mjs");
writeFileSync(stub, "export const getLanguage = () => 'zh';\n");
const entry = path.join(outDir, "entry.ts");
writeFileSync(entry, [
  `export * from ${JSON.stringify(path.join(root, "src/services/source-tasks.ts"))};`,
  `export { getActionOverview } from ${JSON.stringify(path.join(root, "src/core/selectors.ts"))};`,
].join("\n"));
await esbuild.build({
  entryPoints: [entry], bundle: true, format: "esm", platform: "node",
  outfile: path.join(outDir, "source.mjs"), logLevel: "error", alias: { obsidian: stub },
});
const { upsertSourceTask, rescheduleSourceTask, toSourceSnapshot, getActionOverview } = await import(pathToFileURL(path.join(outDir, "source.mjs")).href);

const TODAY = "2026-11-11";
const SOURCE = "crisp-launchpad:publish-WECHAT-20261111-DEMO";
const empty = () => ({ tasks: {}, projects: {}, areas: {}, cycles: {}, labels: {} });
const opts = (dest = "inbox", id = "task-1") => ({ dest, today: TODAY, now: 1000, id });
const make = (extra = {}, dest) => upsertSourceTask(empty(), { sourceId: SOURCE, title: "发布：Demo", ...extra }, opts(dest));

test("a due date at creation is kept and the task is scheduled, whatever the default destination", () => {
  for (const dest of ["inbox", "today"]) {
    const { task, db, created } = make({ dueDate: "2026-11-20" }, dest);
    assert.equal(created, true);
    assert.equal(task.dueDate, "2026-11-20");
    assert.equal(task.triage, "processed");
    assert.equal(task.focusDate, undefined, "it shows up by its date, not pinned to today");
    assert.equal(getActionOverview(db, TODAY).tasks[0].bucket, "upcoming");
    assert.equal(toSourceSnapshot(task).dueDate, "2026-11-20");
  }
  assert.equal(getActionOverview(make({ dueDate: TODAY }).db, TODAY).tasks[0].bucket, "today");
});

test("without a due date nothing changes: the task follows the default destination", () => {
  const inbox = make();
  assert.equal(inbox.task.triage, "inbox");
  assert.equal("dueDate" in inbox.task, false);
  assert.equal("dueDate" in toSourceSnapshot(inbox.task), false);
  assert.equal(make({}, "today").task.focusDate, TODAY);
});

test("a malformed due date is refused instead of stored", () => {
  for (const bad of ["11/20", "2026-13-01", "2026-02-30", "2026-11-20T08:00", 20261120, {}]) {
    assert.throws(() => make({ dueDate: bad }), /截止日期/, String(bad));
  }
});

test("asking again for the same source never rewrites the existing task", () => {
  const first = make({ dueDate: "2026-11-20" });
  const again = upsertSourceTask(first.db, { sourceId: SOURCE, title: "发布：改过的标题", dueDate: "2026-12-01" }, opts("inbox", "task-2"));
  assert.equal(again.created, false);
  assert.equal(again.db, first.db);
  assert.equal(again.task.dueDate, "2026-11-20");
});

test("a reschedule applies only while Tempo still holds the date it was given", () => {
  const { db } = make({ dueDate: "2026-11-20" });
  const moved = rescheduleSourceTask(db, { sourceId: SOURCE, dueDate: "2026-11-25", ifDueDate: "2026-11-20" }, 2000);
  assert.equal(moved.status, "updated");
  assert.equal(moved.task.dueDate, "2026-11-25");
  assert.equal(moved.task.updatedAt, 2000);
  assert.equal(moved.db.tasks["task-1"].dueDate, "2026-11-25");

  // The user moved it to 11-22 in Tempo: the caller's stale "it was 11-20" must not win.
  const userEdited = { ...db, tasks: { "task-1": { ...db.tasks["task-1"], dueDate: "2026-11-22" } } };
  const kept = rescheduleSourceTask(userEdited, { sourceId: SOURCE, dueDate: "2026-11-25", ifDueDate: "2026-11-20" }, 2000);
  assert.equal(kept.status, "kept");
  assert.equal(kept.db, userEdited);
  assert.equal(kept.task.dueDate, "2026-11-22");
});

test("a reschedule can set a first date and clear its own, but not the user's", () => {
  const plain = make();
  const set = rescheduleSourceTask(plain.db, { sourceId: SOURCE, dueDate: "2026-11-20", ifDueDate: null }, 2000);
  assert.equal(set.status, "updated");
  assert.equal(set.task.dueDate, "2026-11-20");
  assert.equal(set.task.triage, "processed", "a dated task leaves the inbox");

  const cleared = rescheduleSourceTask(set.db, { sourceId: SOURCE, dueDate: null, ifDueDate: "2026-11-20" }, 3000);
  assert.equal(cleared.status, "updated");
  assert.equal("dueDate" in cleared.task, false);

  const notMine = rescheduleSourceTask(set.db, { sourceId: SOURCE, dueDate: null, ifDueDate: "2026-11-19" }, 3000);
  assert.equal(notMine.status, "kept");
  assert.equal(notMine.task.dueDate, "2026-11-20");
});

test("finished, canceled and missing tasks are left alone; bad input is refused", () => {
  const { db } = make({ dueDate: "2026-11-20" });
  for (const status of ["done", "canceled"]) {
    const closed = { ...db, tasks: { "task-1": { ...db.tasks["task-1"], status } } };
    const result = rescheduleSourceTask(closed, { sourceId: SOURCE, dueDate: "2026-11-25", ifDueDate: "2026-11-20" }, 2000);
    assert.equal(result.status, "kept");
    assert.equal(result.db, closed);
  }
  const gone = rescheduleSourceTask(empty(), { sourceId: SOURCE, dueDate: "2026-11-25", ifDueDate: null }, 2000);
  assert.equal(gone.status, "missing");
  assert.equal(gone.task, undefined);
  assert.throws(() => rescheduleSourceTask(db, { sourceId: SOURCE, dueDate: "soon", ifDueDate: "2026-11-20" }, 2000), /截止日期/);
  assert.throws(() => rescheduleSourceTask(db, { sourceId: "nope", dueDate: null, ifDueDate: null }, 2000), /来源标识/);
  const same = rescheduleSourceTask(db, { sourceId: SOURCE, dueDate: "2026-11-20", ifDueDate: "2026-11-20" }, 2000);
  assert.equal(same.status, "kept", "nothing to change is not a write");
  assert.equal(same.db, db);
});
