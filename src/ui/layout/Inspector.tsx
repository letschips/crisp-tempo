import type { JSX } from "preact";
import { useLayoutEffect, useState } from "preact/hooks";
import { getTaskEffort } from "../../core/selectors";
import { isWholeMinutes } from "../../core/store";
import type { Cycle, Project, Task, TaskPriority, TaskStatus } from "../../core/types";
import { getTodayString } from "../../services/date-service";
import { t, tf, type Locale } from "../../services/i18n";
import { summarizeFocus, type ActiveFocus, type FocusEntry } from "../../services/focus-bridge";
import { DatePickerPopover } from "../components/DatePickerPopover";
import { CloseIcon, PlusIcon, StatusIcon } from "../icons/Icons";

interface InspectorProps {
  task: Task;
  locale: Locale;
  projects: Record<string, Project>;
  cycles: Record<string, Cycle>;
  subtasks: Task[];
  /** Subtasks by parent, for estimates summed through every level. */
  childrenMap: Map<string, Task[]>;
  onClose: () => void;
  onUpdateTask: (updates: Partial<Task>) => void;
  onDeleteTask: () => void;
  onAddSubtask: (title: string, parentTaskId?: string) => void;
  onToggleSubtask: (subtaskId: string) => void;
  onDeleteSubtask: (subtaskId: string) => void;
  /** Creating subtasks needs a license; editing existing ones does not. */
  canAddSubtask?: boolean;
  onRequestLicense?: () => void;
  /** Opens the note a task came from (set by tasks created from another plugin, e.g. Pulse memos). */
  onOpenSource?: (notePath: string) => void;
  /** Opens the task's outcome note or URL. */
  onOpenOutcome?: (link: string) => void;
  /** Crisp Focus time on this task. Hidden when Focus is not installed and nothing was recorded. */
  focus?: {
    status: "ready" | "outdated" | "missing";
    entries?: FocusEntry[];
    active: ActiveFocus | null;
    onStart: (mode: "pomodoro" | "single") => void;
    onOpenTimer: () => void;
  };
}

const FOCUS_STATE_KEYS = {
  running: "focusStateRunning",
  paused: "focusStatePaused",
  break: "focusStateBreak",
  waiting: "focusStateWaiting",
} as const;

function FocusSection({ taskId, focus, locale }: { taskId: string; focus: NonNullable<InspectorProps["focus"]>; locale: Locale }): JSX.Element | null {
  const summary = summarizeFocus(focus.entries);
  if (focus.status === "missing" && summary.sessions === 0) return null;
  const here = focus.active?.taskId === taskId ? focus.active.state : null;
  const elsewhere = !!focus.active && !here;
  const total = summary.minutes >= 60
    ? tf("focusTotalHours", locale, { h: Math.floor(summary.minutes / 60), m: summary.minutes % 60 })
    : tf("focusTotalMinutes", locale, { m: summary.minutes });
  return (
    <div className="tempo-focus-section">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>{t("focusSection", locale)}</span>
        {summary.sessions > 0 && <span className="tempo-focus-total">{total}</span>}
      </div>
      {focus.status === "ready" && (here ? (
        <div className="tempo-focus-row">
          <span className={`tempo-focus-state is-${here}`}>{t(FOCUS_STATE_KEYS[here], locale)}</span>
          <button type="button" className="tempo-action-btn" onClick={focus.onOpenTimer}>{t("focusOpenPanel", locale)}</button>
        </div>
      ) : (
        <div className="tempo-focus-row">
          <button type="button" className="tempo-action-btn" onClick={() => focus.onStart("pomodoro")}>{t("focusStartPomodoro", locale)}</button>
          <button type="button" className="tempo-action-btn" onClick={() => focus.onStart("single")}>{t("focusStartSingle", locale)}</button>
        </div>
      ))}
      {focus.status === "ready" && elsewhere && <span className="tempo-focus-note">{t("focusElsewhere", locale)}</span>}
      {focus.status === "outdated" && <span className="tempo-focus-note">{t("focusOutdated", locale)}</span>}
      <span className="tempo-focus-note">
        {summary.sessions > 0 ? tf("focusCounts", locale, { done: summary.completed, cut: summary.interrupted }) : t("focusEmpty", locale)}
      </span>
    </div>
  );
}

/** "Pulse 速记 · 2026-10-09 速记" for Pulse memos, otherwise the note's name. */
function sourceLabel(task: Task, locale: Locale): string {
  const name = (task.notePath ?? "").split("/").pop()?.replace(/\.md$/i, "") ?? "";
  return task.sourceId?.startsWith("crisp-pulse:") ? `${t("sourcePulseMemo", locale)} · ${name}` : name;
}

export function Inspector({
  task,
  locale,
  projects,
  cycles,
  subtasks,
  childrenMap,
  onClose,
  onUpdateTask,
  onDeleteTask,
  onAddSubtask,
  onToggleSubtask,
  onDeleteSubtask,
  canAddSubtask = true,
  onRequestLicense,
  onOpenSource,
  onOpenOutcome,
  focus,
}: InspectorProps): JSX.Element {
  const [newSubtaskTitle, setNewSubtaskTitle] = useState("");
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [descDraft, setDescDraft] = useState(task.description ?? "");
  const [estimateDraft, setEstimateDraft] = useState(task.estimateMinutes ? String(task.estimateMinutes) : "");
  const [nextStepDraft, setNextStepDraft] = useState(task.nextStep ?? "");
  const [outcomeDraft, setOutcomeDraft] = useState(task.outcomeLink ?? "");
  const effort = getTaskEffort(task, childrenMap);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const today = getTodayString();

  // Reset the subtask draft only when a different task is opened.
  useLayoutEffect(() => {
    setNewSubtaskTitle("");
    setConfirmDelete(false);
  }, [task.id]);

  // Sync the text drafts to the stored values, including external edits.
  useLayoutEffect(() => {
    setTitleDraft(task.title);
    setDescDraft(task.description ?? "");
  }, [task.id, task.title, task.description]);

  useLayoutEffect(() => {
    setEstimateDraft(task.estimateMinutes ? String(task.estimateMinutes) : "");
    setNextStepDraft(task.nextStep ?? "");
    setOutcomeDraft(task.outcomeLink ?? "");
  }, [task.id, task.estimateMinutes, task.nextStep, task.outcomeLink]);

  // Zero, negative or non-numeric input clears the estimate instead of storing it.
  const commitEstimate = (raw: string) => {
    const minutes = Math.round(Number(raw.trim()));
    const next = raw.trim() && isWholeMinutes(minutes) ? minutes : undefined;
    setEstimateDraft(next ? String(next) : "");
    if (next !== task.estimateMinutes) onUpdateTask({ estimateMinutes: next });
  };

  /** Text fields commit on blur, trimmed; an empty one removes the field. */
  const commitText = (field: "nextStep" | "outcomeLink", raw: string) => {
    const next = raw.trim() || undefined;
    if (next !== task[field]) onUpdateTask({ [field]: next });
  };

  const blurOnEnter = (e: KeyboardEvent) => {
    if (e.isComposing || (e as any).keyCode === 229) return;
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
  };

  const handleSubtaskKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || (e as any).keyCode === 229) return;
    if (e.key === "Enter" && newSubtaskTitle.trim()) {
      e.preventDefault();
      onAddSubtask(newSubtaskTitle.trim(), task.id);
      setNewSubtaskTitle("");
    }
  };

  return (
    <aside className="tempo-inspector-card">
      <div className="tempo-inspector-header">
        <button
          type="button"
          className="tempo-action-btn tempo-inspector-back-btn"
          onClick={onClose}
          title={t("backBtn", locale)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "5px 10px",
            fontSize: 12.5,
            fontWeight: 500,
            borderRadius: 8,
          }}
        >
          ← {t("backBtn", locale)}
        </button>

        <span className="tempo-card-title" style={{ fontSize: 13.5, fontWeight: 600 }}>
          {t("inspectorTitle", locale)}
        </span>

        <button
          type="button"
          className="tempo-action-btn"
          onClick={onClose}
          title={`${t("closeBtn", locale)} (Esc)`}
          aria-label={t("closeBtn", locale)}
          style={{ padding: 6, borderRadius: 6 }}
        >
          <CloseIcon size={14} />
        </button>
      </div>

      <div className="tempo-inspector-body">
        {/* Editable Title with empty rollback */}
        <input
          type="text"
          className="tempo-inspector-title-input"
          value={titleDraft}
          onInput={(e) => setTitleDraft((e.target as HTMLInputElement).value)}
          onBlur={(e) => {
            const trimmed = (e.target as HTMLInputElement).value.trim();
            if (trimmed) {
              if (trimmed !== task.title) {
                onUpdateTask({ title: trimmed });
              }
            } else {
              setTitleDraft(task.title);
            }
          }}
          onKeyDown={(e) => {
            if (e.isComposing || (e as any).keyCode === 229) return;
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder={t("titlePlaceholder", locale)}
        />

        {/* Property Grid */}
        <div className="tempo-property-grid">
          {/* Status */}
          <span className="tempo-property-label">{t("status", locale)}</span>
          <select
            className="tempo-property-select"
            value={task.status}
            onChange={(e) => {
              const status = (e.target as HTMLSelectElement).value as TaskStatus;
              onUpdateTask({
                status,
                completedAt: status === "done" ? Date.now() : undefined,
                canceledAt: status === "canceled" ? Date.now() : undefined,
              });
            }}
          >
            <option value="todo">{t("statusTodo", locale)}</option>
            <option value="in_progress">{t("statusInProgress", locale)}</option>
            <option value="waiting">{t("statusWaiting", locale)}</option>
            <option value="done">{t("statusDone", locale)}</option>
            <option value="canceled">{t("statusCanceled", locale)}</option>
          </select>

          {/* Priority */}
          <span className="tempo-property-label">{t("priority", locale)}</span>
          <select
            className="tempo-property-select"
            value={task.priority}
            onChange={(e) =>
              onUpdateTask({ priority: (e.target as HTMLSelectElement).value as TaskPriority })
            }
          >
            <option value="urgent">{t("priorityUrgent", locale)}</option>
            <option value="high">{t("priorityHigh", locale)}</option>
            <option value="medium">{t("priorityMedium", locale)}</option>
            <option value="low">{t("priorityLow", locale)}</option>
            <option value="none">{t("priorityNone", locale)}</option>
          </select>

          {/* Project */}
          <span className="tempo-property-label">{t("project", locale)}</span>
          <select
            className="tempo-property-select"
            value={task.projectId || ""}
            onChange={(e) =>
              onUpdateTask({ projectId: (e.target as HTMLSelectElement).value || undefined })
            }
          >
            <option value="">{t("noProject", locale)}</option>
            {Object.values(projects).map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>

          {/* When. An untriaged task shows as Inbox; showing it as Anytime made picking
              Anytime a no-op, because the select value did not change. */}
          <span className="tempo-property-label">{t("when", locale)}</span>
          <select
            className="tempo-property-select"
            value={
              task.triage === "inbox"
                ? "inbox"
                : task.availability === "someday"
                ? "someday"
                : task.focusDate && task.focusDate <= today
                ? "today"
                : "anytime"
            }
            onChange={(e) => {
              const val = (e.target as HTMLSelectElement).value;
              if (val === "inbox") {
                onUpdateTask({ focusDate: undefined, triage: "inbox" });
              } else if (val === "today") {
                onUpdateTask({ focusDate: today, availability: "anytime", triage: "processed" });
              } else if (val === "someday") {
                onUpdateTask({ focusDate: undefined, availability: "someday", triage: "processed" });
              } else {
                onUpdateTask({ focusDate: undefined, availability: "anytime", triage: "processed" });
              }
            }}
          >
            <option value="inbox">{t("inbox", locale)}</option>
            <option value="today">{t("whenToday", locale)}</option>
            <option value="anytime">{t("whenAnytime", locale)}</option>
            <option value="someday">{t("whenSomeday", locale)}</option>
          </select>

          {/* Cycle Sprint */}
          <span className="tempo-property-label">{t("cycle", locale)}</span>
          <select
            className="tempo-property-select"
            value={task.cycleId || ""}
            onChange={(e) => onUpdateTask({ cycleId: (e.target as HTMLSelectElement).value || undefined })}
          >
            <option value="">{t("noCycle", locale)}</option>
            {Object.values(cycles).map((cycle) => (
              <option key={cycle.id} value={cycle.id}>{cycle.title}</option>
            ))}
          </select>

          {/* Due Date */}
          <span className="tempo-property-label">{t("dueDate", locale)}</span>
          <DatePickerPopover
            value={task.dueDate}
            locale={locale}
            align="right"
            placement="auto"
            onChange={(d) => onUpdateTask({ dueDate: d })}
          />

          {/* Estimate. A parent whose subtasks are estimated shows their sum instead: counting
              its own number as well would plan the same work twice. */}
          <span className="tempo-property-label">{t("estimate", locale)}</span>
          {effort.fromSubtasks ? (
            <span className="tempo-estimate-sum">
              {tf("estimateFromSubtasks", locale, { m: effort.minutes })}
              {effort.unestimated > 0 && ` · ${tf("estimateSubtasksUnknown", locale, { n: effort.unestimated })}`}
            </span>
          ) : (
            <div className="tempo-estimate-field">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                step={5}
                className="tempo-property-input tempo-estimate-input"
                value={estimateDraft}
                aria-label={t("estimate", locale)}
                onInput={(e) => setEstimateDraft((e.target as HTMLInputElement).value)}
                onBlur={(e) => commitEstimate((e.target as HTMLInputElement).value)}
                onKeyDown={blurOnEnter}
              />
              <span className="tempo-estimate-unit">{t("minutesUnit", locale)}</span>
            </div>
          )}

          <span className="tempo-property-label">{t("nextStep", locale)}</span>
          <input
            type="text"
            className="tempo-property-input tempo-next-step-input"
            value={nextStepDraft}
            placeholder={t("nextStepPlaceholder", locale)}
            aria-label={t("nextStep", locale)}
            onInput={(e) => setNextStepDraft((e.target as HTMLInputElement).value)}
            onBlur={(e) => commitText("nextStep", (e.target as HTMLInputElement).value)}
            onKeyDown={blurOnEnter}
          />

          <span className="tempo-property-label">{t("outcome", locale)}</span>
          <div className="tempo-outcome-field">
            <input
              type="text"
              className="tempo-property-input tempo-outcome-input"
              value={outcomeDraft}
              placeholder={t("outcomePlaceholder", locale)}
              aria-label={t("outcome", locale)}
              onInput={(e) => setOutcomeDraft((e.target as HTMLInputElement).value)}
              onBlur={(e) => commitText("outcomeLink", (e.target as HTMLInputElement).value)}
              onKeyDown={blurOnEnter}
            />
            {task.outcomeLink && (
              <button
                type="button"
                className="tempo-action-btn tempo-outcome-open"
                title={task.outcomeLink}
                onClick={() => onOpenOutcome?.(task.outcomeLink!)}
              >
                {t("openOutcome", locale)}
              </button>
            )}
          </div>

          {/* Source note, for tasks created from another plugin's item */}
          {task.notePath && (
            <>
              <span className="tempo-property-label">{t("source", locale)}</span>
              <button
                type="button"
                className="tempo-property-source"
                title={task.notePath}
                onClick={() => onOpenSource?.(task.notePath!)}
              >
                {sourceLabel(task, locale)}
              </button>
            </>
          )}
        </div>

        {focus && <FocusSection taskId={task.id} focus={focus} locale={locale} />}

        {/* Description Section. Committed on blur: persisting per keystroke would push one
            undo snapshot and one full-database clone for every character typed. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>
            {t("description", locale)}
          </span>
          <textarea
            className="tempo-desc-textarea"
            value={descDraft}
            placeholder={t("descPlaceholder", locale)}
            onInput={(e) => setDescDraft((e.target as HTMLTextAreaElement).value)}
            onBlur={(e) => {
              const next = (e.target as HTMLTextAreaElement).value;
              if (next !== (task.description ?? "")) {
                onUpdateTask({ description: next || undefined });
              }
            }}
          />
        </div>

        {/* Subtasks Section */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>
              {t("subtasks", locale)}
            </span>
            <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
              {subtasks.filter((s) => s.status === "done").length}/{subtasks.length}
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {subtasks.map((st) => (
              <div key={st.id} className="tempo-subtask-item">
                <button
                  type="button"
                  className="tempo-status-btn"
                  onClick={() => onToggleSubtask(st.id)}
                  aria-label={`${t("status", locale)}: ${st.title}`}
                  aria-pressed={st.status === "done"}
                  style={{ width: 14, height: 14 }}
                >
                  <StatusIcon status={st.status} size={13} />
                </button>
                <span
                  className={`tempo-subtask-title ${st.status === "done" ? "is-done" : ""}`}
                >
                  {st.title}
                </span>
                <button
                  type="button"
                  className="tempo-subtask-delete-btn"
                  onClick={() => onDeleteSubtask(st.id)}
                  title={t("deleteSubtask", locale)}
                  aria-label={`${t("deleteSubtask", locale)}: ${st.title}`}
                >
                  <CloseIcon size={11} />
                </button>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
            <PlusIcon size={12} style={{ color: "var(--text-faint)" }} />
            {canAddSubtask ? (
              <input
                type="text"
                className="tempo-add-subtask-input"
                placeholder={t("addSubtaskPlaceholder", locale)}
                value={newSubtaskTitle}
                onInput={(e) => setNewSubtaskTitle((e.target as HTMLInputElement).value)}
                onKeyDown={handleSubtaskKeyDown}
              />
            ) : (
              <button type="button" className="tempo-subtask-locked-btn" onClick={onRequestLicense}>
                {t("subtaskLocked", locale)}
              </button>
            )}
          </div>
        </div>

        {/* Delete action. Deleting also removes every subtask, so it takes a second click. */}
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--background-modifier-border)" }}>
          {confirmDelete ? (
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                className="tempo-action-btn"
                onClick={onDeleteTask}
                style={{ flex: 1, justifyContent: "center", color: "var(--text-error, #f87171)" }}
              >
                {tf("confirmDelete", locale, { n: subtasks.length + 1 })}
              </button>
              <button
                type="button"
                className="tempo-action-btn"
                onClick={() => setConfirmDelete(false)}
                style={{ justifyContent: "center" }}
              >
                {t("cancelBtn", locale)}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="tempo-action-btn"
              onClick={() => setConfirmDelete(true)}
              style={{ width: "100%", justifyContent: "center", color: "var(--text-error, #f87171)" }}
            >
              {t("deleteTask", locale)}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
