import type { Task, TaskStatus, TodoDatabase } from "../core/types";
import { lt } from "./i18n";

/** What another plugin (e.g. Crisp Pulse) sends to turn one of its items into a task. */
export interface SourceTaskInput {
  /** "<plugin>:<stable id>", e.g. "crisp-pulse:3f2a…". One task per source. */
  sourceId: string;
  title: string;
  description?: string;
  /** Vault path of the note the item lives in; shown as the task's source. */
  notePath?: string;
  /**
   * YYYY-MM-DD. Used only when the task is created (sourceTasksApiVersion 2): a dated task is
   * scheduled straight away instead of waiting in the inbox. Change it later with rescheduleSourceTask.
   */
  dueDate?: string;
}

/** A due date another plugin wants on its task, and the date it last knew the task to have. */
export interface SourceRescheduleInput {
  sourceId: string;
  /** The new date; null clears it. */
  dueDate: string | null;
  /** The change applies only while the task still has this date (null: no date). */
  ifDueDate: string | null;
}

/** The public view of a task, safe to hand to other plugins. */
export interface SourceTaskSnapshot {
  id: string;
  sourceId: string;
  title: string;
  status: TaskStatus;
  completedAt?: number;
  dueDate?: string;
}

export const SOURCE_ID_RE = /^[a-z0-9-]+:[A-Za-z0-9-]{1,128}$/;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 20_000;

export function toSourceSnapshot(task: Task): SourceTaskSnapshot {
  return {
    id: task.id,
    sourceId: task.sourceId ?? "",
    title: task.title,
    status: task.status,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    ...(task.dueDate ? { dueDate: task.dueDate } : {}),
  };
}

/** A real calendar date as YYYY-MM-DD; anything else would make Tempo refuse its own database on load. */
function checkedDueDate(value: unknown): string {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  const date = match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])) : null;
  if (!match || !date || date.getUTCMonth() !== +match[2] - 1 || date.getUTCDate() !== +match[3]) {
    throw new Error(lt("截止日期无效，应为 YYYY-MM-DD", "Invalid due date; expected YYYY-MM-DD"));
  }
  return value as string;
}

export function findSourceTask(db: TodoDatabase, sourceId: string): Task | undefined {
  return Object.values(db.tasks).find((task) => task.sourceId === sourceId);
}

/**
 * Returns the database with a task for this source, reusing an existing one so repeated or
 * retried requests never create duplicates. Placement follows Tempo's own default destination.
 */
export function upsertSourceTask(
  db: TodoDatabase,
  input: SourceTaskInput,
  options: { dest: "inbox" | "today"; today: string; now: number; id: string },
): { db: TodoDatabase; task: Task; created: boolean } {
  if (!SOURCE_ID_RE.test(input.sourceId)) throw new Error(lt("来源标识无效", "Invalid source ID"));
  const title = String(input.title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  if (!title) throw new Error(lt("任务标题为空", "The task title is empty"));
  const existing = findSourceTask(db, input.sourceId);
  if (existing) return { db, task: existing, created: false };
  const description = input.description?.trim().slice(0, MAX_DESCRIPTION) || undefined;
  const dueDate = input.dueDate === undefined ? undefined : checkedDueDate(input.dueDate);
  const task: Task = {
    id: options.id,
    title,
    ...(description ? { description } : {}),
    status: "todo",
    // A task that arrives with a due date is already planned: it goes by its date, like a dated reminder.
    triage: dueDate || options.dest === "today" ? "processed" : "inbox",
    availability: "anytime",
    priority: "none",
    ...(dueDate ? { dueDate } : options.dest === "today" ? { focusDate: options.today } : {}),
    ...(input.notePath ? { notePath: input.notePath } : {}),
    sourceId: input.sourceId,
    createdAt: options.now,
    updatedAt: options.now,
    order: `z${options.now}`,
  };
  return { db: { ...db, tasks: { ...db.tasks, [task.id]: task } }, task, created: true };
}

/**
 * Moves (or clears) the due date of a source's task, but only while the task is open and still has
 * the date the caller last gave it. A date the user changed in Tempo is theirs and stays.
 */
export function rescheduleSourceTask(
  db: TodoDatabase,
  input: SourceRescheduleInput,
  now: number,
): { db: TodoDatabase; task?: Task; status: "updated" | "kept" | "missing" } {
  if (!SOURCE_ID_RE.test(input.sourceId)) throw new Error(lt("来源标识无效", "Invalid source ID"));
  const dueDate = input.dueDate === null ? null : checkedDueDate(input.dueDate);
  const task = findSourceTask(db, input.sourceId);
  if (!task) return { db, status: "missing" };
  const current = task.dueDate ?? null;
  const open = task.status !== "done" && task.status !== "canceled";
  if (!open || current !== (input.ifDueDate ?? null) || current === dueDate) return { db, task, status: "kept" };
  const { dueDate: _old, ...rest } = task;
  const next: Task = dueDate
    ? { ...rest, dueDate, triage: "processed", updatedAt: now }
    : { ...rest, updatedAt: now };
  return { db: { ...db, tasks: { ...db.tasks, [task.id]: next } }, task: next, status: "updated" };
}
