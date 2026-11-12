import type { Task, TodoDatabase } from "./types";

/**
 * Time blocks: a Tempo task scheduled as an event in a Calendar calendar ("Tempo" unless the user
 * picks another). Pure: the EventKit helper and timers live in services/apple-sync.ts.
 *
 * A block shares its title with the task and holds the event's start and end. The link stores the
 * values both sides had at the last sync, like a reminder link:
 * - Title: only one side changed, it wins; both changed, the later edit wins (the event's
 *   lastModifiedDate against the task's updatedAt). Writes carry `expect`, so an edit in Calendar
 *   between reading and writing is not overwritten.
 * - Time: set from Tempo by scheduling (written at once), and taken from Calendar when the event
 *   moved there. An event moved to another day moves the task: today puts it in Today, a later day
 *   sets its start date (it comes back to Today on that day). Finished tasks are never moved.
 * - A finished task keeps its event, as a record. A deleted or canceled task removes its event if
 *   that has not started yet; a started or past one stays. Either way the link is dropped.
 * - An event deleted in Calendar unschedules the task (the link is dropped, the task is unchanged).
 */

export interface BlockLink {
  /** The event's calendarItemIdentifier on the Mac that made it. */
  id: string;
  externalId?: string;
  calendarId?: string;
  title: string;
  /** Epoch ms. */
  start: number;
  end: number;
}

/** A block event as the helper reports it. */
export interface BlockEvent {
  id: string;
  externalId: string | null;
  calendarId: string | null;
  title: string;
  start: number;
  end: number;
  allDay?: boolean;
  modifiedAt: number | null;
  requestedId?: string | null;
}

export interface BlockFetch {
  items: BlockEvent[];
  missing: string[];
}

export interface BlockUpdate {
  taskId: string;
  id: string;
  externalId?: string;
  calendarId?: string;
  expect: { title: string };
  title: string;
}

export interface BlockDelete {
  taskId: string;
  id: string;
  externalId?: string;
  calendarId?: string;
}

export interface BlockSyncPlan {
  db: TodoDatabase;
  blocks: Record<string, BlockLink>;
  updates: BlockUpdate[];
  deletes: BlockDelete[];
  /** Tasks changed from Calendar. */
  pulled: number;
}

const MAX_TITLE = 200;
export const blockTitle = (title: string) => title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);

/** Local "YYYY-MM-DD" of an epoch-ms time. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The task planned for `day`: today puts it in Today, a later day sets its start date. An earlier
 * day, or a finished or canceled task, leaves it as it is (undefined: nothing to change).
 */
export function taskOnDay(task: Task, day: string, today: string, now: number): Task | undefined {
  if (task.status === "done" || task.status === "canceled") return undefined;
  let next: Task;
  if (day === today) {
    next = { ...task, focusDate: today, availability: "anytime", triage: "processed" };
    if (next.startDate && next.startDate > today) delete next.startDate;
  } else if (day > today) {
    next = { ...task, startDate: day, availability: "anytime", triage: "processed" };
    delete next.focusDate;
  } else {
    return undefined;
  }
  const same = next.focusDate === task.focusDate && next.startDate === task.startDate &&
    next.availability === task.availability && next.triage === task.triage;
  return same ? undefined : { ...next, updatedAt: now };
}

export function newBlockLink(event: BlockEvent): BlockLink {
  return {
    id: event.id,
    ...(event.externalId ? { externalId: event.externalId } : {}),
    ...(event.calendarId ? { calendarId: event.calendarId } : {}),
    title: blockTitle(event.title),
    start: event.start,
    end: event.end,
  };
}

function findEvent(link: BlockLink, fetched: BlockFetch): BlockEvent | undefined {
  return fetched.items.find((event) => event.requestedId === link.id) ??
    fetched.items.find((event) => event.id === link.id) ??
    (link.externalId ? fetched.items.find((event) => event.externalId === link.externalId) : undefined);
}

export function planBlockSync(input: {
  db: TodoDatabase;
  blocks: Record<string, BlockLink>;
  fetched: BlockFetch;
  now: number;
  today: string;
}): BlockSyncPlan {
  const { now, today } = input;
  let tasks = input.db.tasks;
  const blocks: Record<string, BlockLink> = { ...input.blocks };
  const updates: BlockUpdate[] = [];
  const deletes: BlockDelete[] = [];
  let pulled = 0;
  const missing = new Set(input.fetched.missing);
  const ref = (link: BlockLink) => ({
    id: link.id,
    ...(link.externalId ? { externalId: link.externalId } : {}),
    ...(link.calendarId ? { calendarId: link.calendarId } : {}),
  });

  for (const [taskId, link] of Object.entries(input.blocks)) {
    const task = tasks[taskId];
    if (!task || task.status === "canceled") {
      if (link.start > now && !missing.has(link.id)) deletes.push({ taskId, ...ref(link) });
      delete blocks[taskId];
      continue;
    }
    const event = findEvent(link, input.fetched);
    if (!event) {
      // Deleted in Calendar: the task is no longer scheduled. Not found for another reason
      // (the read failed): keep the link and try again next time.
      if (missing.has(link.id)) delete blocks[taskId];
      continue;
    }
    let nextTask = task;
    const next: BlockLink = { ...link, id: event.id };
    if (event.externalId) next.externalId = event.externalId;
    if (event.calendarId) next.calendarId = event.calendarId;

    // Title, three-way.
    const taskTitle = blockTitle(task.title);
    const eventTitle = blockTitle(event.title);
    const taskChanged = taskTitle !== link.title;
    const eventChanged = eventTitle !== link.title;
    if (taskTitle === eventTitle) {
      next.title = taskTitle;
    } else if (eventChanged && (!taskChanged || (event.modifiedAt ?? 0) > task.updatedAt)) {
      if (eventTitle) {
        nextTask = { ...nextTask, title: eventTitle, updatedAt: now };
        pulled++;
      }
      next.title = eventTitle || taskTitle;
      if (!eventTitle) updates.push({ taskId, ...ref(next), expect: { title: event.title }, title: taskTitle });
    } else if (taskChanged || eventChanged) {
      updates.push({ taskId, ...ref(next), expect: { title: event.title }, title: taskTitle });
    }

    // Time: moved in Calendar.
    if (event.start !== link.start || event.end !== link.end) {
      const day = localDay(event.start);
      if (day !== localDay(link.start)) {
        const moved = taskOnDay(nextTask, day, today, now);
        if (moved) {
          nextTask = moved;
          pulled++;
        }
      }
      next.start = event.start;
      next.end = event.end;
    }

    if (nextTask !== task) tasks = { ...tasks, [taskId]: nextTask };
    blocks[taskId] = next;
  }
  const db = tasks === input.db.tasks ? input.db : { ...input.db, tasks };
  return { db, blocks, updates, deletes, pulled };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function cleanBlockLink(raw: unknown): BlockLink | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id || typeof raw.title !== "string") return null;
  if (typeof raw.start !== "number" || typeof raw.end !== "number" || !(raw.end > raw.start)) return null;
  const optional = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const externalId = optional(raw.externalId);
  const calendarId = optional(raw.calendarId);
  return {
    id: raw.id,
    ...(externalId ? { externalId } : {}),
    ...(calendarId ? { calendarId } : {}),
    title: raw.title,
    start: raw.start,
    end: raw.end,
  };
}
