export type TaskStatus = "todo" | "in_progress" | "waiting" | "done" | "canceled";

export type TaskTriage = "inbox" | "processed";

export type TaskAvailability = "anytime" | "someday";

export type TaskPriority = "none" | "low" | "medium" | "high" | "urgent";

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  triage: TaskTriage;
  availability: TaskAvailability;
  priority: TaskPriority;
  projectId?: string;
  parentTaskId?: string;
  cycleId?: string;
  startDate?: string; // YYYY-MM-DD
  dueDate?: string;   // YYYY-MM-DD
  focusDate?: string; // YYYY-MM-DD
  labels?: string[];
  estimate?: number;
  notePath?: string;
  /** Stable origin of a task created by another plugin, e.g. "crisp-pulse:<memo id>". One task per source. */
  sourceId?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  canceledAt?: number;
  order: string;
}

export type ProjectStatus = "planned" | "active" | "paused" | "completed" | "canceled";

export interface Project {
  id: string;
  title: string;
  description?: string;
  status: ProjectStatus;
  areaId?: string;
  priority: "none" | "low" | "medium" | "high";
  startDate?: string;
  targetDate?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  order: string;
  color?: string;
}

export interface Area {
  id: string;
  title: string;
  order: string;
}

export interface Cycle {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  status: "current" | "upcoming" | "previous";
}

export interface Label {
  id: string;
  name: string;
  color?: string;
}

export interface TodoDatabase {
  schemaVersion: number;
  tasks: Record<string, Task>;
  projects: Record<string, Project>;
  areas: Record<string, Area>;
  cycles: Record<string, Cycle>;
  labels: Record<string, Label>;
}

export type NavItemKey =
  | "inbox"
  | "today"
  | "upcoming"
  | "anytime"
  | "someday"
  | "waiting"
  | "completed";
