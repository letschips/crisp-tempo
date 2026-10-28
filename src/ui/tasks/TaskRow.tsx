import type { JSX } from "preact";
import { getTaskEffort } from "../../core/selectors";
import type { Project, Task, TaskStatus } from "../../core/types";
import { formatDateDisplay, getTodayString, isOverdue } from "../../services/date-service";
import type { ActiveFocus } from "../../services/focus-bridge";
import { t, tf, type Locale, type TranslationKey } from "../../services/i18n";
import { PriorityIcon, StatusIcon } from "../icons/Icons";
import { FOCUS_STATE_KEYS } from "../layout/Inspector";

const STATUS_LABEL_KEYS: Record<TaskStatus, TranslationKey> = {
  todo: "statusTodo",
  in_progress: "statusInProgress",
  waiting: "statusWaiting",
  done: "statusDone",
  canceled: "statusCanceled",
};

interface TaskRowProps {
  task: Task;
  locale: Locale;
  project?: Project;
  subtasks?: Task[];
  /** Subtasks by parent, for the estimate summed through every level. */
  childrenMap?: Map<string, Task[]>;
  /** What Crisp Focus is doing on this task, when it is the one being timed. */
  focusState?: ActiveFocus["state"] | null;
  isSelected: boolean;
  onSelect: () => void;
  onToggleStatus: () => void;
}

export function TaskRow({
  task,
  locale,
  project,
  subtasks = [],
  childrenMap,
  focusState,
  isSelected,
  onSelect,
  onToggleStatus,
}: TaskRowProps): JSX.Element {
  const isDone = task.status === "done";
  const today = getTodayString();
  const isTaskToday = task.focusDate === today || task.dueDate === today || task.startDate === today;
  const overdue = !isDone && isOverdue(task.dueDate);
  const statusLabel = t(STATUS_LABEL_KEYS[task.status] ?? "statusTodo", locale);

  // Open work shows what it needs next; finished rows stay quiet.
  const open = task.status !== "done" && task.status !== "canceled";
  const estimate = open ? getTaskEffort(task, childrenMap ?? new Map([[task.id, subtasks]])).minutes : 0;
  const startsLater = open && !!task.startDate && task.startDate > today;

  // Subtask progress
  const doneSubtasks = subtasks.filter((s) => s.status === "done").length;
  const hasSubtasks = subtasks.length > 0;

  return (
    <div
      className={`tempo-task-row ${isSelected ? "is-selected" : ""} ${isDone ? "is-done" : ""}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      role="button"
      aria-label={task.title}
      tabIndex={0}
      draggable={true}
      onDragStart={(e: DragEvent) => {
        if (!e.dataTransfer) return;
        e.dataTransfer.setData("application/x-tempo-task-id", task.id);
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
        (e.currentTarget as HTMLElement).classList.add("is-dragging");
      }}
      onDragEnd={(e: DragEvent) => {
        (e.currentTarget as HTMLElement).classList.remove("is-dragging");
      }}
    >
      {/* 1. Status Toggle */}
      <div
        className="tempo-status-btn"
        onClick={(e) => {
          e.stopPropagation();
          onToggleStatus();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            onToggleStatus();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label={`${t("status", locale)}: ${task.title}`}
        title={statusLabel}
      >
        <StatusIcon status={task.status} size={15} />
      </div>

      {/* 2. Linear-style Priority */}
      <PriorityIcon priority={task.priority} size={14} />

      {/* 3. Title */}
      <div className="tempo-task-title" title={open && task.nextStep ? `${task.title}\n${t("nextStep", locale)}: ${task.nextStep}` : task.title}>
        {task.title}
        {open && task.nextStep && <span className="tempo-task-next">{task.nextStep}</span>}
      </div>

      {focusState && <span className={`tempo-row-focus is-${focusState}`}>{t(FOCUS_STATE_KEYS[focusState], locale)}</span>}

      {/* 4. Subtask Indicator */}
      {hasSubtasks && (
        <span
          className="tempo-project-tag tempo-subtask-badge"
          style={{ fontSize: 10, padding: "1px 5px" }}
          title={`${doneSubtasks}/${subtasks.length} ${t("subtasks", locale)}`}
        >
          {doneSubtasks}/{subtasks.length}
        </span>
      )}

      {estimate > 0 && (
        <span className="tempo-row-estimate" title={t("estimate", locale)}>{tf("estimateShort", locale, { m: estimate })}</span>
      )}

      {/* 5. Meta: Project Tag */}
      {project && (
        <div className="tempo-project-tag" title={`${t("project", locale)}: ${project.title}`}>
          <span
            className="tempo-project-dot"
            style={{ backgroundColor: project.color || "var(--interactive-accent)" }}
          />
          <span>{project.title}</span>
        </div>
      )}

      {startsLater && (
        <div className="tempo-date-tag tempo-start-tag" data-label={t("startShort", locale)} title={`${t("planStartDate", locale)}: ${task.startDate}`}>
          {formatDateDisplay(task.startDate, locale)}
        </div>
      )}

      {/* 6. Meta: Date Tag */}
      {task.dueDate && (
        <div
          className={`tempo-date-tag ${overdue ? "is-overdue" : isTaskToday ? "is-today" : ""}`}
          title={`${t("dueDate", locale)}: ${task.dueDate}`}
        >
          {overdue ? `${t("overdue", locale)} ` : ""}
          {formatDateDisplay(task.dueDate, locale)}
        </div>
      )}
    </div>
  );
}
