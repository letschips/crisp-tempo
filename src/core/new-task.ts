import type { Task, TaskPriority } from "./types";

/** What the new-task dialog hands back. */
export interface NewTaskInput {
  title: string;
  description?: string;
  triage: "inbox" | "processed";
  availability?: "anytime" | "someday";
  priority?: TaskPriority;
  focusDate?: string;
  startDate?: string;
  dueDate?: string;
  projectId?: string;
  cycleId?: string;
}

/** Builds a task from the new-task dialog. The Tempo view and the floating dialog share it, so both create the same task. */
export function buildNewTask(params: NewTaskInput, now = Date.now()): Task {
  const id = `task-${now}-${Math.random().toString(36).substring(2, 6)}`;
  return {
    id,
    title: params.title,
    description: params.description,
    status: "todo",
    triage: params.triage,
    availability: params.availability || "anytime",
    priority: params.priority || "none",
    projectId: params.projectId,
    cycleId: params.cycleId,
    focusDate: params.focusDate,
    startDate: params.startDate,
    dueDate: params.dueDate,
    createdAt: now,
    updatedAt: now,
    order: `z${now}`,
  };
}
