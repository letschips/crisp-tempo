// Where Tempo goes when another plugin opens one of its tasks (Crisp Search, Pulse, Launchpad call
// revealTask). Failure modes:
// - the inspector shows the task but the list behind it does not have it (a done task opened while on
//   今天), so the row cannot be seen and arrow keys start from nowhere;
// - the list jumps away although the task was already on screen;
// - a subtask sends the list somewhere its parent is not (lists show top-level tasks only);
// - the list picked does not actually show the task (rules drift from what the sidebar lists show).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "tempo-reveal-nav-"));
await esbuild.build({
  entryPoints: [path.join(root, "src/core/selectors.ts")], bundle: true, format: "esm", platform: "node",
  outfile: path.join(outDir, "selectors.mjs"), logLevel: "error",
});
const { navForReveal, getNavTasks } = await import(pathToFileURL(path.join(outDir, "selectors.mjs")).href);

const TODAY = "2026-11-12";
const base = { status: "todo", triage: "processed", availability: "anytime", priority: "none", createdAt: 1, updatedAt: 1, order: "a" };
const t = (id, extra = {}) => ({ id, title: id, ...base, ...extra });
const tasks = Object.fromEntries([
  t("today", { focusDate: TODAY }),
  t("inbox", { triage: "inbox" }),
  t("later", { dueDate: "2026-12-01" }),
  t("any"),
  t("some", { availability: "someday" }),
  t("wait", { status: "waiting" }),
  t("done", { status: "done", completedAt: 1 }),
  t("child", { parentTaskId: "done" }),
  t("grandchild", { parentTaskId: "child" }),
  t("orphan", { parentTaskId: "gone" }),
].map((x) => [x.id, x]));
const db = { tasks, projects: { p1: { id: "p1", title: "P" } }, cycles: {} };

test("a task already in the list on screen keeps the list", () => {
  assert.equal(navForReveal(db, "any", "anytime", TODAY), "anytime");
  assert.equal(navForReveal(db, "wait", "waiting", TODAY), "waiting");
});

test("otherwise the list goes to the first sidebar list that shows the task", () => {
  for (const [id, nav] of [["today", "today"], ["inbox", "inbox"], ["later", "upcoming"], ["any", "anytime"], ["some", "someday"], ["wait", "anytime"], ["done", "completed"]]) {
    const picked = navForReveal(db, id, "inbox" === nav ? "today" : "inbox", TODAY);
    assert.equal(picked, nav, id);
    assert.ok(getNavTasks(tasks, picked, TODAY).some((x) => x.id === id), `${id} is listed under ${picked}`);
  }
});

test("a subtask goes where its top-level parent is listed; a broken parent chain stays put", () => {
  assert.equal(navForReveal(db, "grandchild", "today", TODAY), "completed");
  assert.equal(navForReveal(db, "orphan", "today", TODAY), "today");
  assert.equal(navForReveal(db, "missing", "today", TODAY), "today");
  const loop = { ...db, tasks: { ...tasks, a: t("a", { parentTaskId: "b" }), b: t("b", { parentTaskId: "a" }) } };
  assert.equal(navForReveal(loop, "a", "today", TODAY), "today", "a parent loop does not hang");
});

test("a task in no smart list falls back to its project, then its cycle", () => {
  // Waiting tasks also show under 等待; a canceled task is only under 已完成, so build one that is in none.
  const odd = { ...db, tasks: { ...tasks, x: t("x", { triage: "other", projectId: "p1" }), y: t("y", { triage: "other", projectId: "nope", cycleId: "c1" }) }, cycles: { c1: { id: "c1" } } };
  assert.equal(navForReveal(odd, "x", "today", TODAY), "proj:p1");
  assert.equal(navForReveal(odd, "y", "today", TODAY), "cycle:c1");
});

test("getNavTasks lists what each sidebar entry lists", () => {
  assert.deepEqual(getNavTasks(tasks, "completed", TODAY).map((x) => x.id), ["done"]);
  assert.deepEqual(getNavTasks(tasks, "proj:p1", TODAY), []);
  assert.deepEqual(getNavTasks(tasks, "unknown", TODAY), []);
});
