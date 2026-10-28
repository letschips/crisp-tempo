import type { TodoDatabase } from "./types";
import { addFocusEntry, type FocusLog } from "../services/focus-bridge";
import type { AppleSettings, ReminderLink } from "./apple-sync";

/**
 * Three-way merge of data.json when another device (a sync service) changed it while this device
 * had edits not yet on disk. `base` is the file as this device last read or wrote it.
 *
 * Tasks, projects, cycles, areas and labels merge one object at a time: a side that left an object
 * as it was in `base` takes the other side's version, including a deletion. When both sides changed
 * the same object differently, or one edited what the other deleted, this device's version is kept
 * (an edit beats a deletion either way) and the object is reported as a conflict, so the caller can
 * keep the other side's file before overwriting it. Focus sessions are only ever added, so both
 * sides' sessions are kept.
 */

export interface MergeConflict {
  kind: "task" | "project" | "cycle" | "area" | "label" | "setting";
  id: string;
  title: string;
}

/** JSON with object keys sorted, so the same content written by another device compares equal. */
export function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val === null || typeof val !== "object" || Array.isArray(val)) return val;
    return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

const same = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b);

/** The merged value, or `conflict` when both sides changed it differently. */
function pick<T>(base: T | undefined, local: T | undefined, remote: T | undefined): { value: T | undefined; conflict: boolean } {
  if (same(local, remote)) return { value: local, conflict: false };
  if (same(local, base)) return { value: remote, conflict: false };
  if (same(remote, base)) return { value: local, conflict: false };
  return { value: local ?? remote, conflict: true };
}

function titleOf(value: unknown, id: string): string {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.title === "string" && record.title) return record.title;
    if (typeof record.name === "string" && record.name) return record.name;
  }
  return id;
}

function mergeCollection<T>(
  kind: MergeConflict["kind"],
  base: Record<string, T> | undefined,
  local: Record<string, T>,
  remote: Record<string, T>,
  conflicts: MergeConflict[],
): Record<string, T> {
  const out: Record<string, T> = {};
  // An id only in `base` was deleted on both sides and stays deleted.
  for (const id of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const { value, conflict } = pick(base?.[id], local[id], remote[id]);
    if (conflict) conflicts.push({ kind, id, title: titleOf(value, id) });
    if (value !== undefined) out[id] = value;
  }
  return out;
}

export function mergeDatabase(
  base: TodoDatabase | undefined,
  local: TodoDatabase,
  remote: TodoDatabase,
  conflicts: MergeConflict[],
): TodoDatabase {
  return {
    schemaVersion: 1,
    tasks: mergeCollection("task", base?.tasks, local.tasks, remote.tasks, conflicts),
    projects: mergeCollection("project", base?.projects, local.projects, remote.projects, conflicts),
    cycles: mergeCollection("cycle", base?.cycles, local.cycles, remote.cycles, conflicts),
    areas: mergeCollection("area", base?.areas, local.areas ?? {}, remote.areas ?? {}, conflicts),
    labels: mergeCollection("label", base?.labels, local.labels ?? {}, remote.labels ?? {}, conflicts),
  };
}

/** One plain setting; a conflict keeps this device's value. */
export function mergeSetting<T>(name: string, base: T | undefined, local: T | undefined, remote: T | undefined, conflicts: MergeConflict[]): T | undefined {
  const { value, conflict } = pick(base, local, remote);
  if (conflict) {
    conflicts.push({ kind: "setting", id: name, title: name });
    return local;
  }
  return value;
}

/** Sessions recorded on either side, each once. */
export function mergeFocusLog(local: FocusLog | undefined, remote: FocusLog | undefined): FocusLog | undefined {
  let out: FocusLog = { ...(local ?? {}) };
  for (const [taskId, entries] of Object.entries(remote ?? {})) {
    for (const entry of entries) out = addFocusEntry(out, taskId, entry);
  }
  for (const taskId of Object.keys(out)) out[taskId] = [...out[taskId]].sort((a, b) => a.endedAt - b.endedAt);
  return Object.keys(out).length ? out : undefined;
}

/**
 * Reminders and Calendar settings merge like plain settings; reminder links merge one task at a
 * time. A link only records what the last sync agreed on, so when both sides changed one, this
 * device's is kept without reporting a conflict: the next sync compares it against the reminder again.
 */
export function mergeAppleSettings(
  base: AppleSettings | undefined,
  local: AppleSettings | undefined,
  remote: AppleSettings | undefined,
  conflicts: MergeConflict[],
): AppleSettings | undefined {
  const field = <K extends Exclude<keyof AppleSettings, "links">>(key: K) =>
    mergeSetting(`apple.${key}`, base?.[key], local?.[key], remote?.[key], conflicts);
  const links: Record<string, ReminderLink> = {};
  const localLinks = local?.links ?? {};
  const remoteLinks = remote?.links ?? {};
  for (const id of new Set([...Object.keys(localLinks), ...Object.keys(remoteLinks)])) {
    const { value } = pick(base?.links?.[id], localLinks[id], remoteLinks[id]);
    if (value !== undefined) links[id] = value;
  }
  const out: AppleSettings = {
    remindersEnabled: field("remindersEnabled"),
    reminderLists: field("reminderLists"),
    sendListId: field("sendListId"),
    calendarEnabled: field("calendarEnabled"),
    hiddenCalendars: field("hiddenCalendars"),
    links: Object.keys(links).length ? links : undefined,
  };
  for (const key of Object.keys(out) as (keyof AppleSettings)[]) if (out[key] === undefined) delete out[key];
  return Object.keys(out).length ? out : undefined;
}
