import { normalizePath, type DataAdapter, type Plugin, type Stat, type WorkspaceLeaf } from "obsidian";
import { createEmptyDatabase } from "./mock-data";
import type { Locale } from "../services/i18n";
import type { Area, Cycle, Label, Project, Task, TodoDatabase } from "./types";
import type { LicensePayload, LicenseVerifyResult } from "../services/license";
import { discoverVaultCrispLicense, verifyLicenseCode } from "../services/license";

export interface TempoPluginData {
  schemaVersion: number;
  locale: Locale;
  defaultDest?: "inbox" | "today";
  exportFolder?: string;
  licenseKey?: string;
  licenseStatus?: "valid" | "invalid" | "unlicensed";
  licensePayload?: LicensePayload;
  licenseLastVerified?: number;
  database: TodoDatabase;
}

export type StoreLoadStatus = "loading" | "ready" | "error";
export type StoreSaveStatus = "idle" | "saving" | "saved" | "error";

/** A single rejected entry, reported so the user can see what is wrong before deciding. */
export interface DatabaseProblem {
  entry: string;
  reason: string;
}

export interface DatabaseValidation {
  valid: boolean;
  db?: TodoDatabase;
  error?: string;
  problems: DatabaseProblem[];
  dropped: string[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TASK_STATUSES = ["todo", "in_progress", "waiting", "done", "canceled"];
const TASK_TRIAGE = ["inbox", "processed"];
const TASK_AVAILABILITY = ["anytime", "someday"];
const TASK_PRIORITIES = ["none", "low", "medium", "high", "urgent"];
const PROJECT_PRIORITIES = ["none", "low", "medium", "high"];
const PROJECT_STATUSES = ["planned", "active", "paused", "completed", "canceled"];
const CYCLE_STATUSES = ["current", "upcoming", "previous"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An absent field is allowed; a present one must be text. */
function optionalStringProblem(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? null : `${field} is not a string`;
}

/** An absent field is allowed; a present one must be a plain YYYY-MM-DD date. */
function optionalDateProblem(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return `${field} is not a YYYY-MM-DD string`;
  return DATE_PATTERN.test(value) ? null : `${field} is not a YYYY-MM-DD date`;
}

function requiredDateProblem(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return `${field} is missing`;
  return optionalDateProblem(value, field);
}

function optionalTimestampProblem(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? null : `${field} is not a number`;
}

function optionalStringArrayProblem(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return `${field} is not an array`;
  return value.every((item) => typeof item === "string") ? null : `${field} contains a non-string item`;
}

function enumProblem(value: unknown, allowed: string[], field: string): string | null {
  return allowed.includes(String(value)) ? null : `${field} is not one of ${allowed.join(" | ")}`;
}

function taskProblem(value: unknown, id: string): string | null {
  if (!isRecord(value)) return "entry is not an object";
  if (value.id !== id) return "id does not match its key";
  if (typeof value.title !== "string") return "title is not a string";
  return (
    enumProblem(value.status, TASK_STATUSES, "status") ??
    enumProblem(value.triage, TASK_TRIAGE, "triage") ??
    enumProblem(value.availability, TASK_AVAILABILITY, "availability") ??
    enumProblem(value.priority, TASK_PRIORITIES, "priority") ??
    (typeof value.createdAt === "number" ? null : "createdAt is not a number") ??
    (typeof value.updatedAt === "number" ? null : "updatedAt is not a number") ??
    (typeof value.order === "string" ? null : "order is not a string") ??
    optionalDateProblem(value.startDate, "startDate") ??
    optionalDateProblem(value.dueDate, "dueDate") ??
    optionalDateProblem(value.focusDate, "focusDate") ??
    optionalTimestampProblem(value.completedAt, "completedAt") ??
    optionalTimestampProblem(value.canceledAt, "canceledAt") ??
    optionalTimestampProblem(value.estimate, "estimate") ??
    optionalStringArrayProblem(value.labels, "labels") ??
    optionalStringProblem(value.description, "description") ??
    optionalStringProblem(value.projectId, "projectId") ??
    optionalStringProblem(value.parentTaskId, "parentTaskId") ??
    optionalStringProblem(value.cycleId, "cycleId") ??
    optionalStringProblem(value.notePath, "notePath") ??
    optionalStringProblem(value.sourceId, "sourceId")
  );
}

function projectProblem(value: unknown, id: string): string | null {
  if (!isRecord(value)) return "entry is not an object";
  if (value.id !== id) return "id does not match its key";
  if (typeof value.title !== "string") return "title is not a string";
  return (
    enumProblem(value.status, PROJECT_STATUSES, "status") ??
    enumProblem(value.priority, PROJECT_PRIORITIES, "priority") ??
    (typeof value.createdAt === "number" ? null : "createdAt is not a number") ??
    (typeof value.updatedAt === "number" ? null : "updatedAt is not a number") ??
    (typeof value.order === "string" ? null : "order is not a string") ??
    optionalDateProblem(value.startDate, "startDate") ??
    optionalDateProblem(value.targetDate, "targetDate") ??
    optionalTimestampProblem(value.completedAt, "completedAt") ??
    optionalStringProblem(value.description, "description") ??
    optionalStringProblem(value.areaId, "areaId") ??
    optionalStringProblem(value.color, "color")
  );
}

function cycleProblem(value: unknown, id: string): string | null {
  if (!isRecord(value)) return "entry is not an object";
  if (value.id !== id) return "id does not match its key";
  if (typeof value.title !== "string") return "title is not a string";
  return (
    requiredDateProblem(value.startDate, "startDate") ??
    requiredDateProblem(value.endDate, "endDate") ??
    enumProblem(value.status, CYCLE_STATUSES, "status")
  );
}

function areaProblem(value: unknown, id: string): string | null {
  if (!isRecord(value)) return "entry is not an object";
  if (value.id !== id) return "id does not match its key";
  if (typeof value.title !== "string") return "title is not a string";
  return typeof value.order === "string" ? null : "order is not a string";
}

function labelProblem(value: unknown, id: string): string | null {
  if (!isRecord(value)) return "entry is not an object";
  if (value.id !== id) return "id does not match its key";
  if (typeof value.name !== "string") return "name is not a string";
  return optionalStringProblem(value.color, "color");
}

/**
 * Validates a database payload.
 *
 * Strict mode (the default) rejects the whole payload when any entry is malformed, so a
 * damaged file is never silently trimmed. Salvage mode is only reachable through an
 * explicit user action on the error screen: it keeps the healthy entries and reports
 * exactly what it dropped.
 */
export function validateDatabase(
  raw: unknown,
  options: { salvage?: boolean } = {},
): DatabaseValidation {
  const problems: DatabaseProblem[] = [];
  const dropped: string[] = [];

  if (!isRecord(raw)) {
    return { valid: false, error: "Database payload is not an object", problems, dropped };
  }
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    return { valid: false, error: "Unsupported database schema version", problems, dropped };
  }
  for (const collection of ["tasks", "projects", "cycles"] as const) {
    if (!isRecord(raw[collection])) {
      return { valid: false, error: `Missing or invalid ${collection} collection`, problems, dropped };
    }
  }
  for (const collection of ["areas", "labels"] as const) {
    if (raw[collection] !== undefined && !isRecord(raw[collection])) {
      return { valid: false, error: `Invalid ${collection} collection`, problems, dropped };
    }
  }

  const collect = <T>(
    source: Record<string, unknown>,
    kind: string,
    inspect: (value: unknown, id: string) => string | null,
  ): Record<string, T> => {
    const kept: Record<string, T> = {};
    for (const [id, value] of Object.entries(source)) {
      const reason = inspect(value, id);
      if (reason) {
        problems.push({ entry: `${kind}:${id}`, reason });
        dropped.push(`${kind}:${id}`);
      } else {
        kept[id] = value as T;
      }
    }
    return kept;
  };

  const tasks = collect<Task>(raw.tasks as Record<string, unknown>, "task", taskProblem);
  const projects = collect<Project>(raw.projects as Record<string, unknown>, "project", projectProblem);
  const cycles = collect<Cycle>(raw.cycles as Record<string, unknown>, "cycle", cycleProblem);
  const areas = collect<Area>((raw.areas ?? {}) as Record<string, unknown>, "area", areaProblem);
  const labels = collect<Label>((raw.labels ?? {}) as Record<string, unknown>, "label", labelProblem);

  if (problems.length > 0 && !options.salvage) {
    const first = problems[0];
    const plural = problems.length === 1 ? "entry" : "entries";
    return {
      valid: false,
      error: `${problems.length} invalid ${plural} — first: ${first.entry} (${first.reason})`,
      problems,
      dropped,
    };
  }

  return {
    valid: true,
    problems,
    dropped: options.salvage ? dropped : [],
    db: { schemaVersion: 1, tasks, projects, cycles, areas, labels },
  };
}

type RawDataResult =
  | { kind: "missing" }
  | { kind: "ok"; payload: unknown }
  | { kind: "unreadable"; detail: string };

export class TempoStore {
  private static instances = new WeakMap<Plugin, TempoStore>();
  private static readonly MAX_BACKUPS = 3;

  public plugin: Plugin;
  public status: StoreLoadStatus = "loading";
  public loadError: string | null = null;
  /** Entries the validator rejected, surfaced so the error screen can explain itself. */
  public loadProblems: DatabaseProblem[] = [];
  /** Last locale read from disk, so the error screen can render in the user's language. */
  public loadLocale: Locale | null = null;
  public saveStatus: StoreSaveStatus = "idle";
  public saveError: string | null = null;

  public data: TempoPluginData | null = null;
  public undoStack: TodoDatabase[] = [];
  public readonly MAX_UNDO_DEPTH = 50;

  private listeners = new Set<() => void>();
  private quickAddListeners = new Set<{ listener: () => void; leaf?: WorkspaceLeaf }>();
  private pendingQuickAddIntent = false;
  private pendingQuickAddLeaf: WorkspaceLeaf | null = null;
  private revealListeners = new Set<(taskId: string) => void>();
  private pendingRevealTaskId: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSaveData: TempoPluginData | null = null;
  private flushPromise: Promise<void> | null = null;
  private currentRevision = 0;
  private savedRevision = 0;
  private loadPromise: Promise<TempoPluginData> | null = null;

  public static get(plugin: Plugin): TempoStore {
    let instance = TempoStore.instances.get(plugin);
    if (!instance) {
      instance = new TempoStore(plugin);
      TempoStore.instances.set(plugin, instance);
    }
    return instance;
  }

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public openQuickAdd(leaf?: WorkspaceLeaf): void {
    const target = [...this.quickAddListeners].find((entry) => !leaf || entry.leaf === leaf);
    if (!target) {
      this.pendingQuickAddIntent = true;
      this.pendingQuickAddLeaf = leaf ?? null;
      return;
    }
    try {
      target.listener();
    } catch (err) {
      console.error("Error in openQuickAdd listener:", err);
    }
  }

  public onQuickAdd(listener: () => void, leaf?: WorkspaceLeaf): () => void {
    const entry = { listener, leaf };
    this.quickAddListeners.add(entry);
    if (this.pendingQuickAddIntent && (!this.pendingQuickAddLeaf || this.pendingQuickAddLeaf === leaf)) {
      this.pendingQuickAddIntent = false;
      this.pendingQuickAddLeaf = null;
      setTimeout(() => {
        if (this.quickAddListeners.has(entry)) {
          try {
            listener();
          } catch (err) {
            console.error("Error dispatching deferred quickAdd intent:", err);
          }
        } else {
          this.pendingQuickAddIntent = true;
          this.pendingQuickAddLeaf = leaf ?? null;
        }
      }, 50);
    }
    return () => this.quickAddListeners.delete(entry);
  }

  /** Asks an open Tempo view to select a task; kept until a view subscribes when none is open yet. */
  public revealTask(taskId: string): void {
    if (this.revealListeners.size === 0) {
      this.pendingRevealTaskId = taskId;
      return;
    }
    for (const listener of this.revealListeners) {
      try {
        listener(taskId);
      } catch (err) {
        console.error("Error in revealTask listener:", err);
      }
    }
  }

  public onRevealTask(listener: (taskId: string) => void): () => void {
    this.revealListeners.add(listener);
    const pending = this.pendingRevealTaskId;
    if (pending) {
      this.pendingRevealTaskId = null;
      setTimeout(() => {
        if (this.revealListeners.has(listener)) listener(pending);
        else this.pendingRevealTaskId = pending;
      }, 50);
    }
    return () => this.revealListeners.delete(listener);
  }

  public notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error("Error in TempoStore listener:", err);
      }
    }
  }

  public async load(forceReload = false): Promise<TempoPluginData> {
    if (!forceReload && this.status === "ready" && this.data) return this.data;
    if (forceReload && (this.pendingSaveData || this.flushPromise)) {
      await this.flush();
      if (this.pendingSaveData) throw new Error("Cannot reload while changes are unsaved");
    }
    if (this.loadPromise) {
      return this.loadPromise;
    }

    this.loadPromise = this.doLoad();
    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  /**
   * Explicit recovery path offered by the error screen: keeps every healthy entry and
   * permanently drops the ones the validator rejected. A daily backup is written first.
   */
  public async loadDroppingInvalidEntries(): Promise<TempoPluginData> {
    if (this.loadPromise) await this.loadPromise.catch(() => {});
    this.status = "loading";
    this.data = null;
    this.loadError = null;
    this.notify();

    this.loadPromise = this.doLoad(true);
    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async doLoad(salvage = false): Promise<TempoPluginData> {
    this.status = "loading";
    this.loadError = null;
    this.loadProblems = [];
    this.undoStack = [];
    this.notify();

    const raw = await this.readRawData();

    // A file that exists but cannot be parsed is never a first install. Refuse to write so
    // the original bytes survive for the user to inspect or restore.
    if (raw.kind === "unreadable") {
      const detail = `data.json 无法读取：${raw.detail}`;
      console.error("Crisp Tempo: refusing to load, data.json is unreadable", raw.detail);
      this.status = "error";
      this.loadError = detail;
      this.notify();
      throw new Error(detail);
    }

    if (raw.kind === "missing") {
      const initial: TempoPluginData = {
        schemaVersion: 1,
        locale: "zh",
        defaultDest: "inbox",
        database: createEmptyDatabase(),
      };
      await this.writeData(initial);
      this.data = initial;
      this.status = "ready";
      this.notify();
      return initial;
    }

    const payload = raw.payload;
    const topLevelError = TempoStore.describeTopLevelProblem(payload);
    if (topLevelError) {
      this.status = "error";
      this.loadError = topLevelError;
      this.notify();
      throw new Error(topLevelError);
    }

    const record = payload as Record<string, unknown>;
    this.loadLocale = record.locale === "en" ? "en" : "zh";
    const validation = validateDatabase(record.database, { salvage });
    this.loadProblems = validation.problems;

    if (!validation.valid || !validation.db) {
      const detail = validation.error || "Invalid database structure";
      console.error("Crisp Tempo: refusing to load, database is invalid", validation.problems);
      this.status = "error";
      this.loadError = detail;
      this.notify();
      throw new Error(detail);
    }

    const cleanData: TempoPluginData = {
      schemaVersion: 1,
      locale: record.locale === "en" ? "en" : "zh",
      defaultDest: record.defaultDest === "today" ? "today" : "inbox",
      exportFolder: typeof record.exportFolder === "string" ? record.exportFolder : undefined,
      licenseKey: typeof record.licenseKey === "string" ? record.licenseKey : undefined,
      licenseStatus:
        record.licenseStatus === "valid" ||
        record.licenseStatus === "invalid" ||
        record.licenseStatus === "unlicensed"
          ? record.licenseStatus
          : undefined,
      licensePayload: isRecord(record.licensePayload)
        ? (record.licensePayload as any)
        : undefined,
      licenseLastVerified:
        typeof record.licenseLastVerified === "number"
          ? record.licenseLastVerified
          : undefined,
      database: validation.db,
    };

    // Auto-discover sibling Crisp license from vault if unlicensed and not explicitly deactivated
    if (!cleanData.licenseKey && cleanData.licenseStatus !== "unlicensed") {
      try {
        const vaultLicense = await discoverVaultCrispLicense(this.plugin?.app);
        if (vaultLicense) {
          const res = await verifyLicenseCode(vaultLicense, "crisp-tempo", {
            online: false,
          });
          if (res.valid) {
            cleanData.licenseKey = vaultLicense;
            cleanData.licenseStatus = "valid";
            cleanData.licensePayload = res.payload;
            cleanData.licenseLastVerified = Date.now();
            console.log("Crisp Tempo: 已继承库内可用的 Crisp 授权");
          }
        }
      } catch (err) {
        console.debug("Crisp Tempo: license auto-inheritance check failed", err);
      }
    }

    // The stored status is only a cache. Creation is gated on it, so it is re-derived from the
    // key's local Ed25519 signature on every load: a hand-edited "valid" without a genuine key
    // must not unlock anything. The online device check below may still downgrade it.
    if (cleanData.licenseKey) {
      try {
        const local = await verifyLicenseCode(cleanData.licenseKey, "crisp-tempo", { online: false });
        cleanData.licenseStatus = local.valid ? "valid" : "invalid";
        if (local.payload) cleanData.licensePayload = local.payload;
      } catch (err) {
        console.debug("Crisp Tempo: local license check failed", err);
        cleanData.licenseStatus = "invalid";
      }
    } else if (cleanData.licenseStatus === "valid") {
      cleanData.licenseStatus = undefined;
      cleanData.licensePayload = undefined;
    }

    // If an existing license key is present, verify in the background asynchronously
    if (cleanData.licenseKey) {
      void verifyLicenseCode(cleanData.licenseKey, "crisp-tempo")
        .then((res) => {
          if (this.data && this.data.licenseKey === cleanData.licenseKey) {
            this.data.licenseStatus = res.valid ? "valid" : "invalid";
            if (res.payload) this.data.licensePayload = res.payload;
            this.data.licenseLastVerified = Date.now();
            this.notify();
            this.saveDebounced(1000);
          }
        })
        .catch((err) => {
          console.debug("Crisp Tempo: background license verification failed", err);
        });
    }

    // One recoverable snapshot per day, taken before this session starts writing.
    await this.ensureDailyBackup();

    if (salvage && validation.dropped.length > 0) {
      await this.writeData(cleanData);
    }

    this.data = cleanData;
    this.status = "ready";
    this.notify();
    return cleanData;
  }

  private static describeTopLevelProblem(payload: unknown): string | null {
    if (!isRecord(payload)) return "data.json 的顶层结构不是对象";
    if (payload.schemaVersion !== undefined && payload.schemaVersion !== 1) {
      return `不支持的数据结构版本：${String(payload.schemaVersion)}`;
    }
    return null;
  }

  private resolveDataFilePath(): string | null {
    const dir = this.plugin?.manifest?.dir;
    if (typeof dir !== "string" || dir.length === 0) return null;
    return `${dir.replace(/\\/g, "/").replace(/\/+$/, "")}/data.json`;
  }

  private get adapter(): DataAdapter | null {
    return this.plugin?.app?.vault?.adapter ?? null;
  }

  private static describeError(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err) ?? "unknown error";
    } catch {
      return "unknown error";
    }
  }

  /**
   * Reads data.json without trusting Plugin.loadData()'s return value.
   *
   * Obsidian's readJson returns null only for a missing file (ENOENT) and undefined for
   * every other failure, JSON parse errors included. Collapsing the two would make a
   * damaged file indistinguishable from a first install, so the adapter is queried directly
   * whenever the plugin folder can be resolved.
   */
  private async readRawData(): Promise<RawDataResult> {
    const adapter = this.adapter;
    const path = this.resolveDataFilePath();

    if (adapter && path) {
      try {
        if (!(await adapter.exists(path))) return { kind: "missing" };
      } catch (err) {
        return { kind: "unreadable", detail: TempoStore.describeError(err) };
      }
      try {
        return { kind: "ok", payload: JSON.parse(await adapter.read(path)) };
      } catch (err) {
        return { kind: "unreadable", detail: TempoStore.describeError(err) };
      }
    }

    // Fallback when the plugin folder is unknown: null still means "no file", while
    // undefined means "the file is there but could not be read".
    try {
      const legacy = await this.plugin.loadData();
      if (legacy === null) return { kind: "missing" };
      if (legacy === undefined) {
        return { kind: "unreadable", detail: "data.json exists but could not be parsed" };
      }
      return { kind: "ok", payload: legacy };
    } catch (err) {
      return { kind: "unreadable", detail: TempoStore.describeError(err) };
    }
  }

  /**
   * Writes data.json and confirms the result.
   *
   * Plugin.saveData() cannot be used for failure detection: Obsidian's writeJson swallows
   * every error without rethrowing or logging, so a failed write is indistinguishable from
   * a successful one. Writing through the adapter keeps the failure observable.
   */
  private async writeData(payload: TempoPluginData): Promise<void> {
    const adapter = this.adapter;
    const path = this.resolveDataFilePath();

    if (!adapter || !path) {
      await this.plugin.saveData(payload);
      return;
    }

    const text = JSON.stringify(payload, null, 2);
    await adapter.write(path, text, { mtime: Date.now() });

    const expectedBytes = new TextEncoder().encode(text).byteLength;
    const stat = await this.statOrNull(adapter, path);
    if (!stat) throw new Error("data.json 写入后不存在");
    if (stat.size !== expectedBytes) {
      // Some adapters normalise line endings, so confirm by reading the file back.
      const echo = await adapter.read(path);
      if (echo !== text) {
        throw new Error(`data.json 写入不完整（期望 ${expectedBytes} 字节，实际 ${stat.size} 字节）`);
      }
    }
  }

  private async statOrNull(adapter: DataAdapter, path: string): Promise<Stat | null> {
    try {
      return await adapter.stat(path);
    } catch {
      return null;
    }
  }

  private async ensureDailyBackup(): Promise<void> {
    const adapter = this.adapter;
    const path = this.resolveDataFilePath();
    if (!adapter || !path) return;

    try {
      if (!(await adapter.exists(path))) return;
      const backupPath = `${path}.bak-${TempoStore.dayStamp(new Date())}`;
      if (await adapter.exists(backupPath)) return;
      await adapter.write(backupPath, await adapter.read(path));
      await this.pruneBackups(adapter, path);
    } catch (err) {
      // A missing backup must never stop the database from loading.
      console.warn("Crisp Tempo: could not write the daily backup", err);
    }
  }

  private async pruneBackups(adapter: DataAdapter, path: string): Promise<void> {
    try {
      const folder = path.slice(0, path.lastIndexOf("/"));
      const prefix = `${folder}/data.json.bak-`;
      const listing = await adapter.list(folder);
      const stale = listing.files
        .filter((file) => file.startsWith(prefix))
        .sort()
        .reverse()
        .slice(TempoStore.MAX_BACKUPS);
      for (const file of stale) await adapter.remove(file);
    } catch (err) {
      console.warn("Crisp Tempo: could not prune old backups", err);
    }
  }

  private static dayStamp(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}${month}${day}`;
  }

  /**
   * Copies the on-disk data.json into the vault root. This works even when the file cannot
   * be parsed, which is exactly when the user needs a copy of the original bytes.
   */
  public async exportRawData(customFolder?: string): Promise<string> {
    const adapter = this.adapter;
    if (!adapter) throw new Error("无法访问文件系统以导出数据");

    const now = new Date();
    const stamp = `${TempoStore.dayStamp(now)}-${String(now.getHours()).padStart(2, "0")}${String(
      now.getMinutes(),
    ).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const filename = `crisp-tempo-data-${stamp}.json`;

    // Folder precedence: customFolder > stored exportFolder > vault root. The folder is a
    // vault-relative path, so a ".." segment that would climb out of the vault is refused.
    const rawFolder = (customFolder !== undefined ? customFolder : (this.data?.exportFolder || ""))
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/")
      .replace(/^\/+|\/+$/g, "");
    if (rawFolder.split("/").some((part) => part === "..")) {
      throw new Error(`导出目录不能包含 “..”：${rawFolder}`);
    }
    const folder = rawFolder ? normalizePath(rawFolder) : "";

    if (folder) {
      const parts = folder.split("/");
      let currentPath = "";
      for (const part of parts) {
        if (!part) continue;
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        if (!(await adapter.exists(currentPath))) {
          await adapter.mkdir(currentPath);
        }
      }
    }

    const target = folder ? `${folder}/${filename}` : filename;
    const path = this.resolveDataFilePath();

    if (path) {
      await adapter.write(target, await adapter.read(path));
      return target;
    }

    const legacy = await this.plugin.loadData();
    await adapter.write(target, JSON.stringify(legacy ?? null, null, 2));
    return target;
  }

  public updateDatabase(updater: (prev: TodoDatabase) => TodoDatabase, recordUndo = true): void {
    if (this.status !== "ready" || !this.data) {
      console.warn("Cannot update database when store is not ready (status:", this.status, ")");
      return;
    }

    const prevDb = this.data.database;
    const nextDb = updater(prevDb);
    if (nextDb === prevDb) return;
    if (recordUndo) this.pushUndo(prevDb);
    this.data = {
      ...this.data,
      database: nextDb,
    };

    this.notify();
    this.saveDebounced();
  }

  public pushUndo(db: TodoDatabase): void {
    this.undoStack.push(JSON.parse(JSON.stringify(db)));
    if (this.undoStack.length > this.MAX_UNDO_DEPTH) {
      this.undoStack.shift();
    }
  }

  public popUndo(): TodoDatabase | null {
    if (this.undoStack.length === 0) return null;
    return this.undoStack.pop() || null;
  }

  public undo(): boolean {
    const prev = this.popUndo();
    if (!prev || !this.data) return false;

    this.data = {
      ...this.data,
      database: prev,
    };
    this.notify();
    this.saveDebounced();
    return true;
  }

  public setLocale(locale: Locale): void {
    if (!this.data) return;
    this.data = { ...this.data, locale };
    this.notify();
    this.saveDebounced();
  }

  public setDefaultDest(defaultDest: "inbox" | "today"): void {
    if (!this.data) return;
    this.data = { ...this.data, defaultDest };
    this.notify();
    this.saveDebounced();
  }

  public setExportFolder(exportFolder: string): void {
    if (!this.data) return;
    const trimmed = exportFolder.trim();
    this.data = { ...this.data, exportFolder: trimmed || undefined };
    this.notify();
    this.saveDebounced();
  }

  public resetToEmpty(): void {
    if (!this.data) return;
    // Push current database before reset so user can ⌘Z undo!
    this.pushUndo(this.data.database);

    const freshDb = createEmptyDatabase();
    this.data = {
      ...this.data,
      database: freshDb,
    };
    this.notify();
    this.saveDebounced();
  }

  public async activateLicense(code: string): Promise<LicenseVerifyResult> {
    const res = await verifyLicenseCode(code, "crisp-tempo");
    if (res.valid && this.data) {
      this.data = {
        ...this.data,
        licenseKey: code.trim(),
        licenseStatus: "valid",
        licensePayload: res.payload,
        licenseLastVerified: Date.now(),
      };
      this.notify();
      this.saveDebounced(50);
      await this.flush();
    }
    return res;
  }

  public async clearLicense(): Promise<void> {
    if (!this.data) return;
    this.data = {
      ...this.data,
      licenseKey: undefined,
      licenseStatus: "unlicensed",
      licensePayload: undefined,
      licenseLastVerified: undefined,
    };
    this.notify();
    this.saveDebounced(50);
    await this.flush();
  }

  /** True while edits are only in memory; flush() reports failures through saveStatus, not by throwing. */
  public get hasPendingSave(): boolean {
    return this.pendingSaveData !== null;
  }

  public saveDebounced(delay = 300): void {
    if (!this.data) return;
    this.currentRevision++;
    this.pendingSaveData = JSON.parse(JSON.stringify(this.data));
    this.saveStatus = "saving";
    this.saveError = null;
    this.notify();

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      void this.flush();
    }, delay);
  }

  public async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.flushPromise) return this.flushPromise;
    if (!this.pendingSaveData) return;

    this.flushPromise = this.flushPending();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }

  private async flushPending(): Promise<void> {
    try {
      while (this.pendingSaveData && this.currentRevision > this.savedRevision) {
        const rev = this.currentRevision;
        const payload = this.pendingSaveData;
        this.saveStatus = "saving";
        this.notify();
        await this.writeData(payload);
        this.savedRevision = rev;
        if (this.currentRevision === rev) this.pendingSaveData = null;
      }
      this.saveStatus = "saved";
      this.saveError = null;
      this.notify();
    } catch (err: any) {
      console.error("Crisp Tempo saveData failed:", err);
      this.saveStatus = "error";
      this.saveError = err?.message || "Failed to save data";
      this.notify();
    }
  }
}
