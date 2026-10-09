import type { Task, TaskStatus, TodoDatabase } from "../core/types";

/** What another plugin (e.g. Crisp Pulse) sends to turn one of its items into a task. */
export interface SourceTaskInput {
  /** "<plugin>:<stable id>", e.g. "crisp-pulse:3f2a…". One task per source. */
  sourceId: string;
  title: string;
  description?: string;
  /** Vault path of the note the item lives in; shown as the task's source. */
  notePath?: string;
}

/** The public view of a task, safe to hand to other plugins. */
export interface SourceTaskSnapshot {
  id: string;
  sourceId: string;
  title: string;
  status: TaskStatus;
  completedAt?: number;
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
  };
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
  if (!SOURCE_ID_RE.test(input.sourceId)) throw new Error("来源标识无效");
  const title = String(input.title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  if (!title) throw new Error("任务标题为空");
  const existing = findSourceTask(db, input.sourceId);
  if (existing) return { db, task: existing, created: false };
  const description = input.description?.trim().slice(0, MAX_DESCRIPTION) || undefined;
  const task: Task = {
    id: options.id,
    title,
    ...(description ? { description } : {}),
    status: "todo",
    triage: options.dest === "today" ? "processed" : "inbox",
    availability: "anytime",
    priority: "none",
    ...(options.dest === "today" ? { focusDate: options.today } : {}),
    ...(input.notePath ? { notePath: input.notePath } : {}),
    sourceId: input.sourceId,
    createdAt: options.now,
    updatedAt: options.now,
    order: `z${options.now}`,
  };
  return { db: { ...db, tasks: { ...db.tasks, [task.id]: task } }, task, created: true };
}
