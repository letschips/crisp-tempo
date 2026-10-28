import { Notice, type Plugin } from "obsidian";
import { TempoStore, type AppleAccess, type AppleCalendarInfo } from "../core/store";
import type { Task } from "../core/types";
import {
  confirmUpdate,
  linkValuesOf,
  newLink,
  planReminderSync,
  type AppleReminder,
  type CalendarEvent,
  type ReminderFetch,
  type ReminderUpdate,
} from "../core/apple-sync";
import { AppleHelperError, appleHelperSupported, runAppleHelper } from "./apple-helper";
import { getTodayString } from "./date-service";
import { lt } from "./i18n";

/** Reminders changes are picked up this often, and when Obsidian comes back to the front. */
const SYNC_INTERVAL_MS = 5 * 60_000;
const FOCUS_MIN_GAP_MS = 60_000;
/** A Tempo edit to a linked task is written to Reminders this long after the last keystroke. */
const CHANGE_DELAY_MS = 2_000;

type Kind = "reminders" | "calendar";

interface StatusAnswer { reminders: AppleAccess; calendar: AppleAccess }
interface ListsAnswer { lists: AppleCalendarInfo[]; defaultId: string | null }
interface CalendarsAnswer { calendars: AppleCalendarInfo[] }
interface ApplyAnswer {
  updates: { ok: boolean; code?: string; message?: string }[];
  creates: { key: string; ok: boolean; code?: string; message?: string; reminder?: AppleReminder }[];
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));
const needsAccess = (err: unknown) =>
  err instanceof AppleHelperError && (err.code === "permission_denied" || err.code === "not_determined");

/**
 * Keeps Tempo and macOS Reminders in step and loads today's Calendar events, through the EventKit
 * helper. Desktop macOS only; everything runs one at a time so two syncs never interleave.
 */
export class AppleSyncController {
  private queue: Promise<void> = Promise.resolve();
  private queued = false;
  private lastRunAt = 0;
  private changeTimer: number | null = null;
  private linkedSeen = new Map<string, Task | undefined>();
  /** True while this controller writes to the store, so its own changes are not synced back. */
  private applying = false;

  constructor(private plugin: Plugin) {}

  private get store(): TempoStore {
    return TempoStore.get(this.plugin);
  }

  start(): void {
    if (!appleHelperSupported()) return;
    const store = this.store;
    store.setAppleRuntime({ available: true });
    store.appleActions = {
      setEnabled: (kind, enabled) => this.setEnabled(kind, enabled),
      openPrivacySettings: (kind) => this.openPrivacySettings(kind),
      syncNow: () => this.syncNow(true),
      sendTask: (taskId) => this.sendTask(taskId),
      unlinkTask: (taskId) => this.unlinkTask(taskId),
    };
    this.plugin.register(() => {
      if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
      store.appleActions = null;
    });
    this.plugin.registerInterval(window.setInterval(() => void this.syncNow(), SYNC_INTERVAL_MS));
    this.plugin.registerDomEvent(window, "focus", () => {
      if (Date.now() - this.lastRunAt > FOCUS_MIN_GAP_MS) void this.syncNow();
    });
    this.plugin.register(store.subscribe(() => this.watchLinkedTasks()));
    void store.load().then(() => this.syncNow(), () => {});
  }

  /** Queues a run; while one is waiting, more requests join it. */
  syncNow(manual = false): Promise<void> {
    if (this.queued && !manual) return this.queue;
    this.queued = true;
    this.queue = this.queue.then(async () => {
      this.queued = false;
      await this.run(manual);
    }).catch((err) => console.error("Crisp Tempo: Reminders and Calendar run failed", err));
    return this.queue;
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  private async run(manual: boolean): Promise<void> {
    const store = this.store;
    if (store.status !== "ready" || !store.data) return;
    this.lastRunAt = Date.now();
    const settings = store.data.apple ?? {};
    let status: StatusAnswer;
    try {
      status = await runAppleHelper<StatusAnswer>(this.plugin, "status");
    } catch (err) {
      store.setAppleRuntime({ error: describe(err) });
      if (manual) new Notice(lt(`连接提醒事项和日历失败：${describe(err)}`, `Could not reach Reminders and Calendar: ${describe(err)}`));
      return;
    }
    store.setAppleRuntime({ reminders: status.reminders, calendar: status.calendar, error: undefined });

    if (status.reminders === "fullAccess" && (settings.remindersEnabled || manual || !store.appleRuntime.reminderLists)) {
      await this.loadReminderLists();
    }
    if (status.calendar === "fullAccess" && (settings.calendarEnabled || manual || !store.appleRuntime.calendars)) {
      await this.loadCalendars();
    }
    if (settings.remindersEnabled && status.reminders === "fullAccess") await this.syncReminders(manual);
    if (settings.calendarEnabled && status.calendar === "fullAccess") await this.loadTodayEvents();
    else if (store.appleRuntime.events) store.setAppleRuntime({ events: undefined, eventsDate: undefined });
  }

  private async loadReminderLists(): Promise<void> {
    try {
      const answer = await runAppleHelper<ListsAnswer>(this.plugin, "reminder-lists");
      this.store.setAppleRuntime({ reminderLists: answer.lists, defaultListId: answer.defaultId ?? undefined });
    } catch (err) {
      console.warn("Crisp Tempo: could not list reminder lists", err);
    }
  }

  private async loadCalendars(): Promise<void> {
    try {
      const answer = await runAppleHelper<CalendarsAnswer>(this.plugin, "calendars");
      this.store.setAppleRuntime({ calendars: answer.calendars });
    } catch (err) {
      console.warn("Crisp Tempo: could not list calendars", err);
    }
  }

  private async loadTodayEvents(): Promise<void> {
    const store = this.store;
    const today = getTodayString();
    const from = new Date(`${today}T00:00:00`);
    const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
    const hidden = new Set(store.data?.apple?.hiddenCalendars ?? []);
    const known = store.appleRuntime.calendars;
    const calendars = hidden.size && known ? known.map((c) => c.id).filter((id) => !hidden.has(id)) : null;
    try {
      const answer = await runAppleHelper<{ events: CalendarEvent[] }>(this.plugin, "events", {
        from: from.getTime(),
        to: to.getTime(),
        calendars,
      });
      const events = answer.events
        .filter((event) => !hidden.has(event.calendarId ?? ""))
        .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.title.localeCompare(b.title));
      store.setAppleRuntime({ events, eventsDate: today });
    } catch (err) {
      console.warn("Crisp Tempo: could not load today's events", err);
      if (needsAccess(err)) store.setAppleRuntime({ calendar: "denied", events: undefined });
    }
  }

  private async syncReminders(manual: boolean): Promise<void> {
    const store = this.store;
    const settings = store.data?.apple ?? {};
    const links = settings.links ?? {};
    store.setAppleRuntime({ syncing: true });
    try {
      const fetched = await runAppleHelper<ReminderFetch>(this.plugin, "reminders", {
        lists: settings.reminderLists ?? [],
        items: Object.values(links).map((link) => ({ id: link.id, externalId: link.externalId ?? null })),
      });
      let updates: ReminderUpdate[] = [];
      let imported = 0;
      let pulled = 0;
      this.apply((db, apple) => {
        const now = Date.now();
        const plan = planReminderSync({
          db,
          links: apple.links ?? {},
          fetched,
          now,
          canImport: !!apple.remindersEnabled && store.data?.licenseStatus === "valid",
          newTaskId: () => `task-${now}-${Math.random().toString(36).substring(2, 6)}`,
        });
        updates = plan.updates;
        imported = plan.imported;
        pulled = plan.pulled;
        if (plan.db === db && JSON.stringify(plan.links) === JSON.stringify(apple.links ?? {})) return null;
        return { db: plan.db, apple: { ...apple, links: plan.links } };
      });
      let pushed = 0;
      const failures: string[] = [];
      if (updates.length) {
        const answer = await runAppleHelper<ApplyAnswer>(this.plugin, "apply-reminders", {
          updates: updates.map(({ taskId: _taskId, ...update }) => update),
        });
        this.apply((db, apple) => {
          const next = { ...(apple.links ?? {}) };
          updates.forEach((update, index) => {
            const result = answer.updates[index];
            const link = next[update.taskId];
            if (!result || !link || link.id !== update.id) return;
            if (result.ok) {
              next[update.taskId] = confirmUpdate(link, update);
              pushed++;
            } else if (result.code === "missing") {
              delete next[update.taskId];
            } else {
              failures.push(result.message ?? result.code ?? "?");
            }
          });
          return { db, apple: { ...apple, links: next } };
        });
      }
      const ok = failures.length === 0;
      store.setAppleRuntime({ lastSync: { at: Date.now(), ok, message: failures[0], imported, pulled, pushed } });
      if (manual) {
        new Notice(ok
          ? lt(`已和提醒事项同步：导入 ${imported} 项，更新 ${pulled + pushed} 项`, `Synced with Reminders: ${imported} imported, ${pulled + pushed} updated`)
          : lt(`有 ${failures.length} 项没能写入提醒事项：${failures[0]}`, `${failures.length} change(s) could not be written to Reminders: ${failures[0]}`));
      }
    } catch (err) {
      console.warn("Crisp Tempo: Reminders sync failed", err);
      if (needsAccess(err)) store.setAppleRuntime({ reminders: "denied" });
      store.setAppleRuntime({ lastSync: { at: Date.now(), ok: false, message: describe(err) } });
      if (manual) new Notice(lt(`和提醒事项同步失败：${describe(err)}`, `Reminders sync failed: ${describe(err)}`));
    } finally {
      store.setAppleRuntime({ syncing: false });
    }
  }

  /** Turning a source on asks macOS for access the first time; it stays off when access is refused. */
  private async setEnabled(kind: Kind, enabled: boolean): Promise<void> {
    const store = this.store;
    const field = kind === "reminders" ? "remindersEnabled" : "calendarEnabled";
    if (!enabled) {
      store.updateAppleSettings((prev) => ({ ...prev, [field]: false }));
      if (kind === "calendar") store.setAppleRuntime({ events: undefined, eventsDate: undefined });
      return;
    }
    await this.exclusive(async () => {
      let state = store.appleRuntime[kind];
      if (state !== "fullAccess") {
        const answer = await runAppleHelper<StatusAnswer>(this.plugin, "request-access", { [kind]: true });
        store.setAppleRuntime({ reminders: answer.reminders, calendar: answer.calendar });
        state = answer[kind];
      }
      if (state !== "fullAccess") return;
      if (kind === "reminders") await this.loadReminderLists();
      else await this.loadCalendars();
      store.updateAppleSettings((prev) => {
        const next = { ...prev, [field]: true };
        // First time on: Tempo starts with the system's default list rather than every list.
        if (kind === "reminders" && !prev.reminderLists?.length && store.appleRuntime.defaultListId) {
          next.reminderLists = [store.appleRuntime.defaultListId];
        }
        return next;
      });
    }).catch((err) => {
      new Notice(lt(`无法打开${kind === "reminders" ? "提醒事项" : "日历"}：${describe(err)}`, `Could not turn on ${kind === "reminders" ? "Reminders" : "Calendar"}: ${describe(err)}`));
    });
    await this.syncNow();
  }

  private openPrivacySettings(kind: Kind): void {
    const pane = kind === "reminders" ? "Privacy_Reminders" : "Privacy_Calendars";
    try {
      const { execFile } = (window as unknown as { require: (id: string) => any }).require("child_process");
      execFile("open", [`x-apple.systempreferences:com.apple.preference.security?${pane}`]);
    } catch (err) {
      console.warn("Crisp Tempo: could not open System Settings", err);
    }
  }

  private async sendTask(taskId: string): Promise<void> {
    const store = this.store;
    await this.exclusive(async () => {
      const task = store.data?.database.tasks[taskId];
      const settings = store.data?.apple ?? {};
      if (!task || settings.links?.[taskId]) return;
      const values = linkValuesOf(task);
      const answer = await runAppleHelper<ApplyAnswer>(this.plugin, "apply-reminders", {
        creates: [{ key: taskId, listId: settings.sendListId ?? null, title: values.title, notes: values.notes, due: values.due }],
      });
      const created = answer.creates[0];
      if (!created?.ok || !created.reminder) throw new AppleHelperError(created?.code ?? "helper_error", created?.message ?? "?");
      const reminder = created.reminder;
      this.apply((db, apple) => ({
        db,
        apple: { ...apple, links: { ...(apple.links ?? {}), [taskId]: newLink(reminder, values) } },
      }));
      new Notice(lt(`已添加到提醒事项「${reminder.listTitle ?? ""}」`, `Added to Reminders (${reminder.listTitle ?? ""})`));
    }).catch((err) => {
      new Notice(lt(`没能添加到提醒事项：${describe(err)}`, `Could not add to Reminders: ${describe(err)}`));
    });
  }

  /** Stops syncing the task; both it and the reminder stay. An imported task keeps its source, so it is not imported again. */
  private unlinkTask(taskId: string): void {
    this.store.updateAppleSettings((prev) => {
      if (!prev.links?.[taskId]) return prev;
      const links = { ...prev.links };
      delete links[taskId];
      return { ...prev, links };
    });
    this.linkedSeen.delete(taskId);
  }

  private apply(...args: Parameters<TempoStore["applyAppleSync"]>): boolean {
    this.applying = true;
    try {
      return this.store.applyAppleSync(...args);
    } finally {
      this.applying = false;
      this.rememberLinkedTasks();
    }
  }

  private rememberLinkedTasks(): void {
    const data = this.store.data;
    this.linkedSeen = new Map(Object.keys(data?.apple?.links ?? {}).map((id) => [id, data?.database.tasks[id]]));
  }

  /** Writes Tempo edits to linked tasks to Reminders shortly after they are made. */
  private watchLinkedTasks(): void {
    const data = this.store.data;
    const links = data?.apple?.links;
    if (this.applying || !data?.apple?.remindersEnabled || !links) return;
    let changed = false;
    for (const id of Object.keys(links)) {
      if (this.linkedSeen.get(id) !== data.database.tasks[id]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.rememberLinkedTasks();
    if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
    this.changeTimer = window.setTimeout(() => {
      this.changeTimer = null;
      void this.syncNow();
    }, CHANGE_DELAY_MS);
  }
}
