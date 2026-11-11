import type { Task, TodoDatabase } from "../core/types";
import { daysUntil } from "./date-service";
import { formatDueCountdown } from "./due-countdown";
import { t, type Locale } from "./i18n";

// Tempo's tasks as results in Crisp Search (its provider contract, version 1). Search matches the
// entries itself and hands the chosen task id back to revealTask.

/** One row for Crisp Search; see Crisp Search's src/providers.ts. */
export interface SearchEntry {
  id: string;
  title: string;
  text?: string;
  subtitle?: string;
  accessory?: string;
  done?: boolean;
}

export interface SearchProviderLike {
  id: string;
  label: string;
  icon?: string;
  list(): SearchEntry[] | Promise<SearchEntry[]>;
  open(id: string): void | Promise<void>;
}

/** Finished tasks stay findable, the most recent this many. */
export const MAX_DONE_ENTRIES = 300;

function entryOf(task: Task, db: Pick<TodoDatabase, "tasks" | "projects">, today: string, locale: Locale): SearchEntry {
  const done = task.status === "done";
  const project = task.projectId ? db.projects[task.projectId]?.title : undefined;
  const state = done
    ? t("statusDone", locale)
    : task.dueDate
      ? formatDueCountdown(daysUntil(task.dueDate, today), locale)
      : task.status === "waiting" ? t("statusWaiting", locale) : undefined;
  const accessory = [project, state].filter(Boolean).join(" · ");
  const parent = task.parentTaskId ? db.tasks[task.parentTaskId]?.title : undefined;
  const text = [task.nextStep, task.description].filter(Boolean).join("\n");
  return {
    id: task.id,
    title: task.title,
    ...(text ? { text } : {}),
    ...(parent ? { subtitle: parent } : {}),
    ...(accessory ? { accessory } : {}),
    done,
  };
}

/**
 * Every task that is not canceled, subtasks included: open ones first, dated before undated and
 * nearest first, then the most recently finished.
 */
export function searchEntries(db: Pick<TodoDatabase, "tasks" | "projects">, today: string, locale: Locale): SearchEntry[] {
  const tasks = Object.values(db.tasks).filter((task) => task.status !== "canceled");
  const open = tasks
    .filter((task) => task.status !== "done")
    .sort((a, b) =>
      Number(!a.dueDate) - Number(!b.dueDate) ||
      (a.dueDate ?? "").localeCompare(b.dueDate ?? "") ||
      b.updatedAt - a.updatedAt);
  const done = tasks
    .filter((task) => task.status === "done")
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
    .slice(0, MAX_DONE_ENTRIES);
  return [...open, ...done].map((task) => entryOf(task, db, today, locale));
}

/**
 * Registers the provider with Crisp Search when it is enabled and speaks contract 1, dropping an
 * earlier registration first. Returns the cleanup, or null when there is nothing to register with.
 * Never throws: search is an extra, Tempo loads the same without it.
 */
export function connectSearch(app: unknown, provider: SearchProviderLike, previous: (() => void) | null): (() => void) | null {
  try {
    previous?.();
    const search = (app as { plugins?: { plugins?: Record<string, unknown> } })?.plugins?.plugins?.["crisp-search"] as
      | { searchProviderApiVersion?: unknown; registerSearchProvider?: (p: SearchProviderLike) => unknown }
      | undefined;
    if (!search || !(Number(search.searchProviderApiVersion) >= 1) || typeof search.registerSearchProvider !== "function") return null;
    const off = search.registerSearchProvider(provider);
    return typeof off === "function" ? (off as () => void) : null;
  } catch (error) {
    console.debug("Crisp Tempo: could not register with Crisp Search", error);
    return null;
  }
}
