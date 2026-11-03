// Action overview for Crisp Launchpad (0.13.0). Launchpad shows Tempo's tasks on the ANKS
// dashboard and must never disagree with Tempo's own Today list. Failure modes:
// - a task in Tempo's Today list lands in another bucket on the dashboard (or the reverse);
// - subtasks, canceled or someday tasks inflate the dashboard counts;
// - an untriaged inbox task is counted as today's work;
// - a task finished on another day still shows up as done today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "tempo-overview-"));
const outfile = path.join(outDir, "selectors.mjs");
await esbuild.build({
  entryPoints: [path.join(root, "src/core/selectors.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "silent",
});
const { getActionOverview, getTodayTasks } = await import(pathToFileURL(outfile).href);

const TODAY = "2026-11-03";
const base = { status: "todo", triage: "processed", availability: "anytime", priority: "none", createdAt: 1, updatedAt: 1, order: "a" };
const t = (id, extra = {}) => ({ id, title: id, ...base, ...extra });

function db(tasks) {
  return {
    tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
    projects: { p1: { id: "p1", title: "ANKS" } },
  };
}

test("every open task in Tempo's Today list is today or overdue on the dashboard", () => {
  const data = db([
    t("focus-today", { focusDate: TODAY }),
    t("carried-over", { focusDate: "2026-11-01" }),
    t("due-today", { dueDate: TODAY }),
    t("due-past", { dueDate: "2026-10-30" }),
    t("started", { startDate: "2026-11-02" }),
    t("later", { startDate: "2026-11-10" }),
    t("anytime"),
  ]);
  const overview = getActionOverview(data, TODAY);
  const bucket = Object.fromEntries(overview.tasks.map((task) => [task.id, task.bucket]));
  const todayIds = getTodayTasks(data.tasks, TODAY).map((task) => task.id).sort();
  const dashboardToday = overview.tasks.filter((task) => task.bucket === "today" || task.bucket === "overdue").map((task) => task.id).sort();
  assert.deepEqual(dashboardToday, todayIds);
  assert.equal(bucket["due-past"], "overdue");
  assert.equal(bucket["carried-over"], "today");
  assert.equal(bucket.later, "upcoming");
  assert.equal(bucket.anytime, "anytime");
});

test("subtasks, canceled and someday tasks are left out; inbox and waiting keep their own buckets", () => {
  const overview = getActionOverview(db([
    t("parent", { focusDate: TODAY }),
    t("child", { parentTaskId: "parent", focusDate: TODAY }),
    t("canceled", { status: "canceled", focusDate: TODAY }),
    t("someday", { availability: "someday" }),
    t("inbox", { triage: "inbox", dueDate: TODAY }),
    t("waiting", { status: "waiting", focusDate: TODAY }),
  ]), TODAY);
  assert.deepEqual(overview.tasks.map((task) => [task.id, task.bucket]).sort(), [
    ["inbox", "inbox"],
    ["parent", "today"],
    ["waiting", "waiting"],
  ]);
});

test("only tasks finished today count as done, and project titles come along", () => {
  const todayNoon = new Date(2026, 10, 3, 12).getTime();
  const yesterday = new Date(2026, 10, 2, 12).getTime();
  const overview = getActionOverview(db([
    t("done-today", { status: "done", completedAt: todayNoon, projectId: "p1" }),
    t("done-before", { status: "done", completedAt: yesterday }),
  ]), TODAY);
  assert.deepEqual(overview.tasks, [{
    id: "done-today",
    title: "done-today",
    status: "done",
    bucket: "done",
    projectTitle: "ANKS",
    completedAt: todayNoon,
  }]);
  assert.equal(overview.date, TODAY);
});
