import type { Task, TodoDatabase } from "./types";
import { getTodayString } from "../services/date-service";

export interface NavCounts {
  inbox: number;
  today: number;
  upcoming: number;
  anytime: number;
  someday: number;
  waiting: number;
  completed: number;
}

export interface KpiStats {
  todayRemaining: number;
  inProgress: number;
  inbox: number;
  todayDone: number;
}

/**
 * Checks if a unix timestamp falls on the specified calendar day (YYYY-MM-DD).
 */
export function isSameDay(timestamp: number, dateStr: string): boolean {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}` === dateStr;
}

/**
 * Filters top-level tasks (excludes subtasks).
 */
export function getTopLevelTasks(tasks: Record<string, Task> | Task[]): Task[] {
  const list = Array.isArray(tasks) ? tasks : Object.values(tasks);
  return list.filter((t) => !t.parentTaskId);
}

/**
 * Groups subtasks by their parent once per render.
 * Callers used to scan the whole task list for every rendered row, which is O(n²).
 */
export function buildChildrenMap(tasks: Record<string, Task> | Task[]): Map<string, Task[]> {
  const list = Array.isArray(tasks) ? tasks : Object.values(tasks);
  const map = new Map<string, Task[]>();
  for (const task of list) {
    if (!task.parentTaskId) continue;
    const bucket = map.get(task.parentTaskId);
    if (bucket) bucket.push(task);
    else map.set(task.parentTaskId, [task]);
  }
  return map;
}

/**
 * A task is actionable today when it was focused for today (or an earlier day and is still
 * open), already started, or is due. An unfinished Today item carries over to the next day,
 * as in Things 3; without that it silently dropped out of Today at midnight.
 * Shared by the Today list, the Today nav badge and the "today remaining" KPI so all three
 * always agree.
 */
export function isScheduledForToday(task: Task, today = getTodayString()): boolean {
  return (
    (!!task.focusDate && task.focusDate <= today) ||
    (!!task.startDate && task.startDate <= today) ||
    (!!task.dueDate && task.dueDate <= today)
  );
}

/**
 * A finished task belongs to today when it was completed today. Entries saved before
 * completedAt was stamped fall back to their scheduling dates, and the "completed today"
 * KPI uses this same rule so the list and the KPI cannot disagree.
 */
export function isCompletedToday(task: Task, today = getTodayString()): boolean {
  if (task.status !== "done") return false;
  if (typeof task.completedAt === "number") return isSameDay(task.completedAt, today);
  return task.focusDate === today || task.dueDate === today;
}

/**
 * Tasks for Today view:
 * 1. Active (todo/in_progress/waiting) tasks triaged and scheduled for today.
 * 2. Done tasks completed on the local calendar day of today.
 * 3. Excludes canceled tasks and someday tasks.
 *
 * Waiting tasks that are scheduled for today appear here as their own group; the same task
 * is also listed under the Waiting bucket, which is a status view rather than a time bucket.
 */
export function getTodayTasks(tasks: Record<string, Task> | Task[], today = getTodayString()): Task[] {
  return getTopLevelTasks(tasks).filter((t) => {
    if (t.availability === "someday") return false;
    if (t.triage !== "processed") return false;

    if (t.status === "done") return isCompletedToday(t, today);
    if (t.status === "canceled") return false;

    return isScheduledForToday(t, today);
  });
}

export interface DayCapacity {
  /** Estimated minutes of every Today task that is not canceled, finished ones included. */
  plannedMinutes: number;
  /** Open Today tasks with no estimate; they are not counted as zero. */
  unestimated: number;
  capacityMinutes?: number;
  /** How far the plan exceeds the capacity; 0 when it fits or no capacity is set. */
  overMinutes: number;
}

/**
 * A task's planned effort. When any of its live subtasks has an estimate, the subtasks are
 * summed and the task's own number is ignored, so a parent and its parts are never counted twice.
 */
export function getTaskEffort(task: Task, subtasks: Task[] = []): { minutes?: number; fromSubtasks: boolean } {
  const estimated = subtasks.filter((s) => s.status !== "canceled" && s.estimateMinutes);
  if (estimated.length > 0) {
    return { minutes: estimated.reduce((sum, s) => sum + s.estimateMinutes!, 0), fromSubtasks: true };
  }
  return { minutes: task.estimateMinutes || undefined, fromSubtasks: false };
}

/** The Today list's planned effort against the daily capacity. `todayTasks` is getTodayTasks(). */
export function getDayCapacity(
  todayTasks: Task[],
  childrenMap: Map<string, Task[]>,
  capacityMinutes?: number,
): DayCapacity {
  let plannedMinutes = 0;
  let unestimated = 0;
  for (const task of todayTasks) {
    if (task.status === "canceled") continue;
    const { minutes } = getTaskEffort(task, childrenMap.get(task.id));
    if (minutes) plannedMinutes += minutes;
    else if (task.status !== "done") unestimated++;
  }
  const overMinutes = capacityMinutes ? Math.max(0, plannedMinutes - capacityMinutes) : 0;
  return { plannedMinutes, unestimated, capacityMinutes, overMinutes };
}

/**
 * Tasks for Inbox view: items captured but not triaged yet.
 * Items that are already finished or canceled have been handled, so they leave the inbox
 * and remain reachable through the Completed archive.
 */
export function getInboxTasks(tasks: Record<string, Task> | Task[]): Task[] {
  return getTopLevelTasks(tasks).filter(
    (t) => t.triage === "inbox" && t.status !== "done" && t.status !== "canceled"
  );
}

/**
 * Tasks for Upcoming view:
 * Processed active tasks starting or due in the future.
 *
 * This intentionally overlaps with Today: a task that already started but is due later
 * stays on Today and also shows up under its future date, matching how a scheduled list
 * behaves in Things 3. The two buckets are therefore not a partition of the task set.
 */
export function getUpcomingTasks(tasks: Record<string, Task> | Task[], today = getTodayString()): Task[] {
  return getTopLevelTasks(tasks)
    .filter(
      (t) =>
        t.triage === "processed" &&
        t.status !== "done" &&
        t.status !== "canceled" &&
        ((!!t.startDate && t.startDate > today) || (!!t.dueDate && t.dueDate > today))
    )
    .sort((a, b) => upcomingDate(a, today).localeCompare(upcomingDate(b, today)));
}

/** The nearest future date that put a task on the Upcoming list. */
function upcomingDate(task: Task, today: string): string {
  const dates = [task.startDate, task.dueDate].filter((d): d is string => !!d && d > today);
  return dates.sort()[0] ?? "";
}

const STATUS_RANK: Record<Task["status"], number> = {
  in_progress: 0,
  todo: 1,
  waiting: 2,
  done: 3,
  canceled: 4,
};

/**
 * Project and cycle lists mix open and finished work, so open work comes first and the
 * finished tail sinks to the bottom. The sort is stable, so creation order is kept within
 * each status.
 */
export function sortByStatus(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
}

/**
 * Share of finished work. Canceled tasks are out of scope, so they count neither as done
 * nor as remaining; otherwise a single canceled task keeps a project below 100% forever.
 */
export function getProgress(tasks: Task[]): { done: number; total: number; pct: number } {
  const inScope = tasks.filter((t) => t.status !== "canceled");
  const done = inScope.filter((t) => t.status === "done").length;
  const total = inScope.length;
  return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
}

export type CycleTimeStatus = "current" | "upcoming" | "previous";

/**
 * Where a cycle sits relative to today, derived from its dates. The stored `status` is set
 * once at creation and never rolls over, so it cannot tell whether a cycle has ended.
 */
export function getCycleTimeStatus(
  cycle: { startDate: string; endDate: string },
  today = getTodayString(),
): CycleTimeStatus {
  if (cycle.endDate < today) return "previous";
  if (cycle.startDate > today) return "upcoming";
  return "current";
}

/**
 * Tasks for Anytime view:
 * Processed active anytime tasks whose start date has arrived (or is not set).
 */
export function getAnytimeTasks(tasks: Record<string, Task> | Task[], today = getTodayString()): Task[] {
  return getTopLevelTasks(tasks).filter(
    (t) =>
      t.triage === "processed" &&
      t.availability === "anytime" &&
      t.status !== "done" &&
      t.status !== "canceled" &&
      (!t.startDate || t.startDate <= today)
  );
}

/**
 * Tasks for Someday view.
 */
export function getSomedayTasks(tasks: Record<string, Task> | Task[]): Task[] {
  return getTopLevelTasks(tasks).filter(
    (t) =>
      t.availability === "someday" &&
      t.status !== "done" &&
      t.status !== "canceled"
  );
}

/**
 * Tasks for Waiting view.
 */
export function getWaitingTasks(tasks: Record<string, Task> | Task[]): Task[] {
  return getTopLevelTasks(tasks).filter(
    (t) => t.status === "waiting"
  );
}

/**
 * Tasks for the Completed log (Logbook): finished and canceled work, newest first. Canceled
 * tasks used to be reachable only from their project, so they vanished from every list.
 */
export function getCompletedTasks(tasks: Record<string, Task> | Task[]): Task[] {
  const closedAt = (t: Task) => t.completedAt || t.canceledAt || t.updatedAt || 0;
  return getTopLevelTasks(tasks)
    .filter((t) => t.status === "done" || t.status === "canceled")
    .sort((a, b) => closedAt(b) - closedAt(a));
}

/**
 * Computes exact unified navigation counts matching lists.
 * Counts mirror the lists one-for-one, including the deliberate Today/Upcoming and
 * Today/Waiting overlaps described on those selectors.
 */
export function getNavCounts(tasks: Record<string, Task> | Task[], today = getTodayString()): NavCounts {
  const topTasks = getTopLevelTasks(tasks);

  const inbox = topTasks.filter(
    (t) => t.triage === "inbox" && t.status !== "done" && t.status !== "canceled"
  ).length;

  const todayCount = topTasks.filter(
    (t) =>
      t.triage === "processed" &&
      t.availability !== "someday" &&
      t.status !== "done" &&
      t.status !== "canceled" &&
      isScheduledForToday(t, today)
  ).length;

  const upcoming = topTasks.filter(
    (t) =>
      t.triage === "processed" &&
      t.status !== "done" &&
      t.status !== "canceled" &&
      ((!!t.startDate && t.startDate > today) || (!!t.dueDate && t.dueDate > today))
  ).length;

  const anytime = topTasks.filter(
    (t) =>
      t.triage === "processed" &&
      t.availability === "anytime" &&
      t.status !== "done" &&
      t.status !== "canceled" &&
      (!t.startDate || t.startDate <= today)
  ).length;

  const someday = topTasks.filter(
    (t) => t.availability === "someday" && t.status !== "done" && t.status !== "canceled"
  ).length;

  const waiting = topTasks.filter(
    (t) => t.status === "waiting"
  ).length;

  const completed = topTasks.filter((t) => t.status === "done" || t.status === "canceled").length;

  return { inbox, today: todayCount, upcoming, anytime, someday, waiting, completed };
}

/**
 * Computes KPI indicators matching the actual database state.
 * Every value is derived from the same predicates the lists use, so a card can never
 * contradict the view it links to.
 */
export function getKpiStats(tasks: Record<string, Task> | Task[], today = getTodayString()): KpiStats {
  const topTasks = getTopLevelTasks(tasks);

  const todayRemaining = topTasks.filter(
    (t) =>
      t.triage === "processed" &&
      t.availability !== "someday" &&
      t.status !== "done" &&
      t.status !== "canceled" &&
      isScheduledForToday(t, today)
  ).length;

  const inProgress = topTasks.filter((t) => t.status === "in_progress").length;
  const inbox = topTasks.filter(
    (t) => t.triage === "inbox" && t.status !== "done" && t.status !== "canceled"
  ).length;

  const todayDone = topTasks.filter((t) => isCompletedToday(t, today)).length;

  return { todayRemaining, inProgress, inbox, todayDone };
}

/**
 * Returns tasks ordered as they visually appear on screen for a given view.
 * Essential for correct keyboard navigation (ArrowUp/ArrowDown).
 */
export function getVisualOrderTasks(tasks: Task[], activeNav: string): Task[] {
  if (activeNav === "today") {
    const inProgress = tasks.filter((t) => t.status === "in_progress");
    const todo = tasks.filter((t) => t.status === "todo");
    const waiting = tasks.filter((t) => t.status === "waiting");
    const done = tasks.filter((t) => t.status === "done");
    const canceled = tasks.filter((t) => t.status === "canceled");
    return [...inProgress, ...todo, ...waiting, ...done, ...canceled];
  }

  // Other views preserve order or sorted by priority/dueDate
  return [...tasks];
}
