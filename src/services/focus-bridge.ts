import type { App } from "obsidian";
import { lt } from "./i18n";

/**
 * Focus time on tasks, with Crisp Focus 1.7.0+ (focusApiVersion 2). Tempo starts a Focus session
 * bound to a task and records each finished or interrupted focus session on that task. Focus owns
 * the timer; Tempo owns the record.
 */

export const TEMPO_FOCUS_SOURCE = "crisp-tempo";
const FOCUS_ID = "crisp-focus";
const MAX_ENTRIES_PER_TASK = 500;
const MAX_MINUTES = 240;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** One focus session spent on a task. */
export interface FocusEntry {
  /** Focus's session id; one entry per session. */
  id: string;
  startedAt: number;
  endedAt: number;
  /** Planned minutes when it completed, whole minutes actually spent when it was ended early. */
  minutes: number;
  completed: boolean;
  pomodoro: boolean;
}

/** Entries by task id. Kept outside the task database so Tempo's undo never removes them. */
export type FocusLog = Record<string, FocusEntry[]>;

export interface ActiveFocus {
  taskId: string;
  state: "running" | "paused" | "break" | "waiting";
}

export interface FocusSummary {
  minutes: number;
  completed: number;
  interrupted: number;
  sessions: number;
  lastEndedAt: number;
}

interface FocusTask {
  source: string;
  id: string;
  title: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function tempoTaskId(task: unknown): string | null {
  if (!isObject(task) || task.source !== TEMPO_FOCUS_SOURCE) return null;
  return typeof task.id === "string" && ID_RE.test(task.id) ? task.id : null;
}

/** The entry a Focus session event adds to a task, or null when it is not a Tempo task's focus ending. */
export function focusEntryFromEvent(event: unknown): { taskId: string; entry: FocusEntry } | null {
  if (!isObject(event) || !(Number(event.apiVersion) >= 2) || event.kind !== "focus") return null;
  if (event.type !== "complete" && event.type !== "stop") return null;
  const taskId = tempoTaskId(event.task);
  if (!taskId || typeof event.id !== "string" || !event.id) return null;
  const completed = event.type === "complete";
  const raw = completed ? Math.round(Number(event.plannedMinutes) || 0) : Math.floor((Number(event.elapsedMs) || 0) / 60000);
  // A session ended within its first minute is a misclick, not time spent.
  if (raw < 1) return null;
  const startedAt = Number(event.startedAt);
  const endedAt = Number(event.at);
  return {
    taskId,
    entry: {
      id: event.id,
      startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
      endedAt: Number.isFinite(endedAt) ? endedAt : Date.now(),
      minutes: Math.min(MAX_MINUTES, raw),
      completed,
      pomodoro: event.pomodoro === true,
    },
  };
}

/** Returns the log with the entry added, or the same log when this session is already there. */
export function addFocusEntry(log: FocusLog, taskId: string, entry: FocusEntry): FocusLog {
  const list = log[taskId] ?? [];
  if (list.some((item) => item.id === entry.id)) return log;
  return { ...log, [taskId]: [...list, entry].slice(-MAX_ENTRIES_PER_TASK) };
}

function entryIsValid(value: unknown): value is FocusEntry {
  return isObject(value)
    && typeof value.id === "string" && value.id.length > 0
    && Number.isFinite(value.startedAt) && Number.isFinite(value.endedAt)
    && typeof value.minutes === "number" && value.minutes >= 1 && value.minutes <= MAX_MINUTES
    && typeof value.completed === "boolean" && typeof value.pomodoro === "boolean";
}

/** Reads a stored log. Bad entries are dropped and counted; nothing here can stop Tempo loading. */
export function cleanFocusLog(raw: unknown): { log: FocusLog; dropped: number } {
  if (raw === undefined || raw === null) return { log: {}, dropped: 0 };
  if (!isObject(raw)) return { log: {}, dropped: 1 };
  const log: FocusLog = {};
  let dropped = 0;
  for (const [taskId, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) { dropped++; continue; }
    const kept = list.filter(entryIsValid).map((entry) => ({
      id: entry.id, startedAt: entry.startedAt, endedAt: entry.endedAt,
      minutes: entry.minutes, completed: entry.completed, pomodoro: entry.pomodoro,
    }));
    dropped += list.length - kept.length;
    if (kept.length) log[taskId] = kept.slice(-MAX_ENTRIES_PER_TASK);
  }
  return { log, dropped };
}

export function summarizeFocus(entries: readonly FocusEntry[] | undefined): FocusSummary {
  const summary: FocusSummary = { minutes: 0, completed: 0, interrupted: 0, sessions: 0, lastEndedAt: 0 };
  for (const entry of entries ?? []) {
    summary.minutes += entry.minutes;
    summary.sessions++;
    if (entry.completed) summary.completed++;
    else summary.interrupted++;
    summary.lastEndedAt = Math.max(summary.lastEndedAt, entry.endedAt);
  }
  return summary;
}

/** Which Tempo task Focus is working on right now, from Focus's own snapshot. */
export function activeFocusFromSnapshot(snapshot: unknown): ActiveFocus | null {
  if (!isObject(snapshot)) return null;
  const taskId = tempoTaskId(snapshot.task);
  if (!taskId) return null;
  if (snapshot.status === "paused") return { taskId, state: "paused" };
  if (snapshot.status === "running") return { taskId, state: snapshot.kind === "break" ? "break" : "running" };
  if (snapshot.waiting === true) return { taskId, state: "waiting" };
  return null;
}

interface FocusPluginApi {
  focusApiVersion?: number;
  startPomodoro(options?: { task?: FocusTask }): Promise<unknown>;
  startFocusSession(minutes?: number, options?: { task?: FocusTask }): Promise<unknown>;
  getPomodoroSnapshot(): unknown;
  openPomodoroModal?(): void;
}

export function focusPluginStatus(app: App): { status: "ready" | "outdated" | "missing"; plugin?: FocusPluginApi } {
  const plugins = (app as unknown as { plugins?: { plugins?: Record<string, unknown>; enabledPlugins?: Set<string> } }).plugins;
  const plugin = plugins?.plugins?.[FOCUS_ID] as FocusPluginApi | undefined;
  if (!plugin || (plugins?.enabledPlugins && !plugins.enabledPlugins.has(FOCUS_ID))) return { status: "missing" };
  if (!(Number(plugin.focusApiVersion) >= 2) || typeof plugin.startPomodoro !== "function" || typeof plugin.startFocusSession !== "function") {
    return { status: "outdated" };
  }
  return { status: "ready", plugin };
}

/**
 * Starts a Focus session bound to the task. Resolves false when Focus declined (a pomodoro
 * without activation; Focus shows its own notice). An older Focus would ignore the task and run an
 * unbound session, so it is refused instead.
 */
export async function startFocusForTask(app: App, task: { id: string; title: string }, mode: "pomodoro" | "single"): Promise<boolean> {
  const { status, plugin } = focusPluginStatus(app);
  if (status === "outdated") throw new Error(lt("需要 Crisp Focus 1.7.0 或更新版本", "Requires Crisp Focus 1.7.0 or later"));
  if (!plugin) throw new Error(lt("需要先安装并启用 Crisp Focus", "Install and enable Crisp Focus first"));
  const title = task.title.replace(/\s+/g, " ").trim().slice(0, 200);
  const bound = { task: { source: TEMPO_FOCUS_SOURCE, id: task.id, title } };
  const started = mode === "pomodoro" ? await plugin.startPomodoro(bound) : await plugin.startFocusSession(undefined, bound);
  return started !== null && started !== undefined;
}
