import type { Task, TodoDatabase } from "./types";

/**
 * Sync between Tempo tasks and macOS Reminders, plus the stored settings for Reminders and Calendar.
 * Pure: the EventKit helper and timers live in services/apple-sync.ts.
 *
 * A linked task and its reminder share four fields: title, notes (the task's description), due day
 * and done. The link stores the values both sides had at the last sync; a side whose value differs
 * from it changed since. Only one side changed: it wins. Both changed to different values: the side
 * modified later wins (the reminder's lastModifiedDate against the task's updatedAt). Each write
 * carries the values it was planned against, and the helper refuses it when the reminder changed
 * since (an edit on the phone between reading and writing); the next sync merges again.
 *
 * A link switched `off` (unlinked by the user, or a duplicate) no longer syncs but still holds the
 * reminder back from being imported again, like a link whose task was deleted.
 */

export interface ReminderLink {
  /** The reminder's calendarItemIdentifier on the Mac that linked it (differs on other Macs). */
  id: string;
  /** calendarItemExternalIdentifier: the same on every Mac that syncs the list. */
  externalId?: string;
  listId?: string;
  listTitle?: string;
  title: string;
  notes: string;
  due: string | null;
  completed: boolean;
  /** No longer synced; kept so the reminder is not imported again. */
  off?: true;
}

export interface AppleSettings {
  remindersEnabled?: boolean;
  /** Lists whose open reminders become Tempo tasks. Identifiers are per Mac. Unset: never chosen; [] means none. */
  reminderLists?: string[];
  /** List that "Add to Reminders" puts a task in; unset means the system default list. */
  sendListId?: string;
  calendarEnabled?: boolean;
  /** Calendars left out of Today; every other calendar is shown. */
  hiddenCalendars?: string[];
  /** Linked reminders by Tempo task id. A link outlives its task so the reminder is not imported again. */
  links?: Record<string, ReminderLink>;
}

/** A reminder as the helper reports it. */
export interface AppleReminder {
  id: string;
  externalId: string | null;
  listId: string | null;
  listTitle: string | null;
  title: string;
  notes: string;
  due: string | null;
  dueHasTime?: boolean;
  completed: boolean;
  completedAt: number | null;
  modifiedAt: number | null;
  /** For looked-up items: the link id it was asked for. */
  requestedId?: string | null;
}

export interface ReminderFetch {
  /** Open reminders in the chosen lists. */
  reminders: AppleReminder[];
  /** Linked reminders looked up by id, in any list and state. */
  items: AppleReminder[];
  /** Link ids whose reminder no longer exists. */
  missing: string[];
}

export interface ReminderUpdate {
  taskId: string;
  id: string;
  externalId?: string;
  listId?: string;
  /** The reminder's values (as fetched) for the fields being written; the helper writes only if they still hold. */
  expect?: Partial<Pick<AppleReminder, "title" | "notes" | "due" | "completed">>;
  title?: string;
  notes?: string;
  due?: string | null;
  completed?: boolean;
}

export interface ReminderSyncPlan {
  db: TodoDatabase;
  links: Record<string, ReminderLink>;
  /** Tempo-side changes to write to Reminders; their links are updated once the write succeeds. */
  updates: ReminderUpdate[];
  imported: number;
  /** Tasks changed from Reminders. */
  pulled: number;
  unlinked: number;
  /** Tasks found linked to a reminder another task already holds (two Macs imported it at once); their links were switched off. */
  duplicates: number;
}

type Shared = Pick<ReminderLink, "title" | "notes" | "due" | "completed">;
const FIELDS = ["title", "notes", "due", "completed"] as const;
const MAX_TITLE = 200;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const APPLE_SOURCE_PREFIX = "apple-reminders:";

export function reminderTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
}

/** A Tempo source id for a reminder, stable across Macs when the reminder has an external id. */
export function reminderSourceId(reminder: Pick<AppleReminder, "id" | "externalId">): string {
  const key = (reminder.externalId || reminder.id).replace(/[^A-Za-z0-9-]/g, "-").slice(0, 128);
  return APPLE_SOURCE_PREFIX + key;
}

function taskValues(task: Task): Shared {
  return {
    title: task.title,
    notes: task.description ?? "",
    due: task.dueDate ?? null,
    completed: task.status === "done" || task.status === "canceled",
  };
}

function reminderValues(reminder: AppleReminder): Shared {
  return {
    title: reminderTitle(reminder.title),
    notes: reminder.notes ?? "",
    due: reminder.due && DAY_RE.test(reminder.due) ? reminder.due : null,
    completed: reminder.completed,
  };
}

function withValues(task: Task, values: Partial<Shared>, reminder: AppleReminder, now: number): Task {
  let next: Task = { ...task, updatedAt: now };
  if (values.title !== undefined) next.title = values.title;
  if (values.notes !== undefined) {
    if (values.notes) next.description = values.notes;
    else delete next.description;
  }
  if (values.due !== undefined) {
    if (values.due) next.dueDate = values.due;
    else delete next.dueDate;
  }
  if (values.completed !== undefined) {
    if (values.completed) {
      next = { ...next, status: "done", completedAt: reminder.completedAt ?? now };
      delete next.canceledAt;
    } else {
      next = { ...next, status: "todo" };
      delete next.completedAt;
      delete next.canceledAt;
    }
  }
  return next;
}

/** One reminder's identity across Macs: its external id where it has one. */
const linkKey = (link: Pick<ReminderLink, "id" | "externalId">) => link.externalId || `local:${link.id}`;

/**
 * When several active links point at the same reminder, the oldest task keeps it and the others are
 * switched off. Every Mac picks the same one, and no task is deleted: the extra one stays for the user.
 */
function dropDuplicateLinks(links: Record<string, ReminderLink>, tasks: Record<string, Task>): number {
  const groups = new Map<string, string[]>();
  for (const [taskId, link] of Object.entries(links)) {
    if (link.off || !tasks[taskId]) continue;
    const key = linkKey(link);
    groups.set(key, [...(groups.get(key) ?? []), taskId]);
  }
  let dropped = 0;
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    ids.sort((a, b) => tasks[a].createdAt - tasks[b].createdAt || (a < b ? -1 : 1));
    for (const taskId of ids.slice(1)) {
      links[taskId] = { ...links[taskId], off: true };
      dropped++;
    }
  }
  return dropped;
}

function linkMatches(link: ReminderLink, reminder: AppleReminder): boolean {
  return link.id === reminder.id || (!!reminder.externalId && link.externalId === reminder.externalId);
}

export function newLink(reminder: AppleReminder, values: Shared): ReminderLink {
  return {
    id: reminder.id,
    ...(reminder.externalId ? { externalId: reminder.externalId } : {}),
    ...(reminder.listId ? { listId: reminder.listId } : {}),
    ...(reminder.listTitle ? { listTitle: reminder.listTitle } : {}),
    ...values,
  };
}

/**
 * Compares Tempo with what the helper fetched. Changes from Reminders are applied to the returned
 * database (and their links); Tempo changes are returned as updates to write. Open reminders in the
 * chosen lists that no link knows become tasks when `canImport` (creating tasks needs a licence).
 * A reminder with a due day is placed by that day (Today once it is due, Upcoming before); one
 * without goes where Tempo puts new tasks (`dest`), like a quick-added task or a Pulse memo.
 */
export function planReminderSync(input: {
  db: TodoDatabase;
  links: Record<string, ReminderLink>;
  fetched: ReminderFetch;
  now: number;
  canImport: boolean;
  newTaskId: () => string;
  /** Tempo's default destination for new tasks; defaults to the inbox. */
  dest?: "inbox" | "today";
  /** YYYY-MM-DD, for `dest` "today". */
  today?: string;
}): ReminderSyncPlan {
  const { now } = input;
  const tasks = { ...input.db.tasks };
  const links = { ...input.links };
  const updates: ReminderUpdate[] = [];
  const missing = new Set(input.fetched.missing);
  const byRequested = new Map<string, AppleReminder>();
  for (const item of input.fetched.items) byRequested.set(item.requestedId ?? item.id, item);
  let pulled = 0;
  let unlinked = 0;
  let imported = 0;
  const duplicates = dropDuplicateLinks(links, tasks);

  for (const [taskId, link] of Object.entries(links)) {
    const reminder = byRequested.get(link.id);
    if (!reminder) {
      // Deleted in Reminders: the task stays as it is and is no longer linked.
      if (missing.has(link.id)) {
        delete links[taskId];
        unlinked++;
      }
      continue;
    }
    const placed: ReminderLink = {
      ...link,
      ...(reminder.externalId ? { externalId: reminder.externalId } : {}),
      ...(reminder.listId ? { listId: reminder.listId } : {}),
      ...(reminder.listTitle ? { listTitle: reminder.listTitle } : {}),
    };
    const task = tasks[taskId];
    if (!task || link.off) {
      // The task was deleted or unlinked in Tempo; the reminder is left alone. Once it is done, nothing is left to hold back.
      if (reminder.completed) delete links[taskId];
      else links[taskId] = placed;
      continue;
    }
    const mine = taskValues(task);
    const theirs = reminderValues(reminder);
    const pull: Partial<Shared> = {};
    const push: Partial<Shared> = {};
    const appleNewer = (reminder.modifiedAt ?? 0) > task.updatedAt;
    for (const field of FIELDS) {
      const base = link[field];
      const tempoChanged = mine[field] !== base;
      const appleChanged = theirs[field] !== base;
      if (!tempoChanged && !appleChanged) continue;
      if (mine[field] === theirs[field]) {
        (placed as unknown as Record<string, unknown>)[field] = theirs[field];
      } else if (appleChanged && (!tempoChanged || appleNewer)) {
        // An empty title in Reminders never blanks a task.
        if (field === "title" && !theirs.title) {
          push.title = mine.title;
          continue;
        }
        (pull as Record<string, unknown>)[field] = theirs[field];
        (placed as unknown as Record<string, unknown>)[field] = theirs[field];
      } else {
        (push as Record<string, unknown>)[field] = mine[field];
      }
    }
    if (Object.keys(pull).length) {
      tasks[taskId] = withValues(task, pull, reminder, now);
      pulled++;
    }
    links[taskId] = placed;
    if (Object.keys(push).length) {
      const expect: NonNullable<ReminderUpdate["expect"]> = {};
      for (const field of FIELDS) {
        if (push[field] !== undefined) (expect as Record<string, unknown>)[field] = reminder[field] ?? (field === "notes" ? "" : null);
      }
      updates.push({
        taskId,
        id: link.id,
        ...(placed.externalId ? { externalId: placed.externalId } : {}),
        ...(placed.listId ? { listId: placed.listId } : {}),
        ...push,
        expect,
      });
    }
  }

  if (input.canImport) {
    const known = Object.values(links);
    const sourced = new Set(Object.values(tasks).map((task) => task.sourceId).filter(Boolean));
    for (const reminder of input.fetched.reminders) {
      if (reminder.completed) continue;
      if (known.some((link) => linkMatches(link, reminder))) continue;
      const sourceId = reminderSourceId(reminder);
      if (sourced.has(sourceId)) continue;
      const values = reminderValues(reminder);
      if (!values.title) continue;
      const id = input.newTaskId();
      const task: Task = {
        id,
        title: values.title,
        ...(values.notes ? { description: values.notes } : {}),
        status: "todo",
        triage: values.due || input.dest === "today" ? "processed" : "inbox",
        availability: "anytime",
        priority: "none",
        ...(values.due ? { dueDate: values.due } : {}),
        ...(!values.due && input.dest === "today" && input.today ? { focusDate: input.today } : {}),
        sourceId,
        createdAt: now,
        updatedAt: now,
        order: `z${now + imported}`,
      };
      tasks[id] = task;
      const link = newLink(reminder, values);
      links[id] = link;
      known.push(link);
      sourced.add(sourceId);
      imported++;
    }
  }

  const changed = pulled > 0 || imported > 0;
  return {
    db: changed ? { ...input.db, tasks } : input.db,
    links,
    updates,
    imported,
    pulled,
    unlinked,
    duplicates,
  };
}

/** After a successful write, the link agrees with what was written (only for fields it still has). */
export function confirmUpdate(link: ReminderLink, update: ReminderUpdate): ReminderLink {
  const next = { ...link };
  for (const field of FIELDS) {
    if (update[field] !== undefined) (next as unknown as Record<string, unknown>)[field] = update[field];
  }
  return next;
}

/** The values a new link from a Tempo task starts from. */
export function linkValuesOf(task: Task): Shared {
  return taskValues(task);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function cleanLink(raw: unknown): ReminderLink | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.title !== "string" || typeof raw.notes !== "string" || typeof raw.completed !== "boolean") return null;
  if (raw.due !== null && !(typeof raw.due === "string" && DAY_RE.test(raw.due))) return null;
  const optional = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const externalId = optional(raw.externalId);
  const listId = optional(raw.listId);
  const listTitle = optional(raw.listTitle);
  return {
    ...(raw.off === true ? { off: true as const } : {}),
    id: raw.id,
    ...(externalId ? { externalId } : {}),
    ...(listId ? { listId } : {}),
    ...(listTitle ? { listTitle } : {}),
    title: raw.title,
    notes: raw.notes,
    due: raw.due as string | null,
    completed: raw.completed,
  };
}

/** Stored settings, keeping what is readable; undefined when nothing is set. */
export function cleanAppleSettings(raw: unknown): AppleSettings | undefined {
  if (!isRecord(raw)) return undefined;
  const ids = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item) : undefined;
  const links: Record<string, ReminderLink> = {};
  if (isRecord(raw.links)) {
    for (const [taskId, value] of Object.entries(raw.links)) {
      const link = cleanLink(value);
      if (link) links[taskId] = link;
    }
  }
  const out: AppleSettings = {
    ...(raw.remindersEnabled === true ? { remindersEnabled: true } : {}),
    // An empty list is a choice ("import nothing") and is kept; only a missing one means "never chosen".
    ...(ids(raw.reminderLists) ? { reminderLists: ids(raw.reminderLists) } : {}),
    ...(typeof raw.sendListId === "string" && raw.sendListId ? { sendListId: raw.sendListId } : {}),
    ...(raw.calendarEnabled === true ? { calendarEnabled: true } : {}),
    ...(ids(raw.hiddenCalendars)?.length ? { hiddenCalendars: ids(raw.hiddenCalendars) } : {}),
    ...(Object.keys(links).length ? { links } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  calendarId?: string;
  calendarTitle?: string;
  color?: string;
  /** EventKit availability: busy, free, tentative, unavailable or notSupported. */
  availability?: string;
  /** EventKit status: none, confirmed, tentative or canceled. */
  status?: string;
}

/** Whether an event takes time from the day: timed, not shown as free, not canceled. */
export function takesTime(event: CalendarEvent): boolean {
  return !event.allDay && event.availability !== "free" && event.status !== "canceled";
}

/** Minutes of events that take time (see takesTime) inside [dayStart, dayEnd), overlaps counted once. */
export function busyMinutes(events: readonly CalendarEvent[], dayStart: number, dayEnd: number): number {
  const spans = events
    .filter((event) => takesTime(event) && event.end > event.start)
    .map((event) => [Math.max(event.start, dayStart), Math.min(event.end, dayEnd)] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursorStart = -1;
  let cursorEnd = -1;
  for (const [start, end] of spans) {
    if (start > cursorEnd) {
      if (cursorEnd > cursorStart) total += cursorEnd - cursorStart;
      cursorStart = start;
      cursorEnd = end;
    } else if (end > cursorEnd) {
      cursorEnd = end;
    }
  }
  if (cursorEnd > cursorStart) total += cursorEnd - cursorStart;
  return Math.round(total / 60000);
}
