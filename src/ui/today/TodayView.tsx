import type { JSX } from "preact";
import type { DayCapacity } from "../../core/selectors";
import type { Project, Task } from "../../core/types";
import type { ActiveFocus } from "../../services/focus-bridge";
import { formatHeaderDate } from "../../services/date-service";
import { t, tf, type Locale } from "../../services/i18n";
import { PlusIcon, TodayIcon } from "../icons/Icons";
import { TaskRow } from "../tasks/TaskRow";

interface TodayViewProps {
  today?: string;
  tasks: Task[];
  locale: Locale;
  /** Subtasks grouped by parent, built once by the caller instead of scanned per row. */
  childrenMap: Map<string, Task[]>;
  projects: Record<string, Project>;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onToggleStatus: (taskId: string) => void;
  onOpenQuickAdd: () => void;
  capacity?: DayCapacity;
  activeFocus?: ActiveFocus | null;
}

/** "已安排 110 / 100 分钟 · 1 项未估时 · 超出 10 分钟"; hidden until something is estimated or budgeted. */
function CapacityLine({ capacity, locale }: { capacity: DayCapacity; locale: Locale }): JSX.Element | null {
  const { plannedMinutes, unestimated, capacityMinutes, overMinutes } = capacity;
  if (!capacityMinutes && plannedMinutes === 0) return null;
  return (
    <div className="tempo-capacity-line">
      <span>
        {capacityMinutes
          ? tf("capacityPlannedOf", locale, { m: plannedMinutes, cap: capacityMinutes })
          : tf("capacityPlanned", locale, { m: plannedMinutes })}
      </span>
      {unestimated > 0 && <span>{" · "}{tf("capacityUnestimated", locale, { n: unestimated })}</span>}
      {overMinutes > 0 && (
        <span>{" · "}<span className="tempo-capacity-over">{tf("capacityOver", locale, { m: overMinutes })}</span></span>
      )}
    </div>
  );
}

export function TodayView({
  today,
  tasks,
  locale,
  childrenMap,
  projects,
  selectedTaskId,
  onSelectTask,
  onToggleStatus,
  onOpenQuickAdd,
  capacity,
  activeFocus,
}: TodayViewProps): JSX.Element {
  const inProgressTasks = tasks.filter((t) => t.status === "in_progress");
  const todoTasks = tasks.filter((t) => t.status === "todo");
  const waitingTasks = tasks.filter((t) => t.status === "waiting");
  const doneTasks = tasks.filter((t) => t.status === "done");

  return (
    <div className="tempo-main-card">
      {/* Header */}
      <div className="tempo-card-header">
        <div className="tempo-card-header-left">
          <span className="tempo-card-title">{t("today", locale)}</span>
          <span className="tempo-card-subtitle">
            {formatHeaderDate(today ? new Date(today + "T00:00:00") : new Date(), locale)}
          </span>
          <span className="tempo-nav-badge">
            {tf("taskCount", locale, { n: tasks.filter((t) => t.status !== "done" && t.status !== "canceled").length })}
          </span>
        </div>
        <button
          type="button"
          className="tempo-card-header-btn"
          onClick={onOpenQuickAdd}
          title={t("newTask", locale)}
        >
          <PlusIcon size={12} />
          <span>{t("newTask", locale)}</span>
        </button>
      </div>

      {capacity && <CapacityLine capacity={capacity} locale={locale} />}

      {/* Task List */}
      <div className="tempo-task-scroll">
        {tasks.length === 0 ? (
          <div className="tempo-empty-state">
            <TodayIcon size={36} className="tempo-empty-icon" />
            <p style={{ margin: 0, fontWeight: 500 }}>{t("noTasksToday", locale)}</p>
          </div>
        ) : (
          <>
            {/* In Progress Group */}
            {inProgressTasks.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div className="tempo-group-header">
                  <span>{t("inProgress", locale)}</span>
                  <span className="tempo-group-count">{inProgressTasks.length}</span>
                </div>
                {inProgressTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    locale={locale}
                    project={task.projectId ? projects[task.projectId] : undefined}
                    subtasks={childrenMap.get(task.id) ?? []}
                    childrenMap={childrenMap}
                    focusState={activeFocus?.taskId === task.id ? activeFocus.state : null}
                    isSelected={selectedTaskId === task.id}
                    onSelect={() => onSelectTask(task.id)}
                    onToggleStatus={() => onToggleStatus(task.id)}
                  />
                ))}
              </div>
            )}

            {/* Todo Group */}
            {todoTasks.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div className="tempo-group-header">
                  <span>{t("tasks", locale)}</span>
                  <span className="tempo-group-count">{todoTasks.length}</span>
                </div>
                {todoTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    locale={locale}
                    project={task.projectId ? projects[task.projectId] : undefined}
                    subtasks={childrenMap.get(task.id) ?? []}
                    childrenMap={childrenMap}
                    focusState={activeFocus?.taskId === task.id ? activeFocus.state : null}
                    isSelected={selectedTaskId === task.id}
                    onSelect={() => onSelectTask(task.id)}
                    onToggleStatus={() => onToggleStatus(task.id)}
                  />
                ))}
              </div>
            )}

            {/* Waiting Group */}
            {waitingTasks.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div className="tempo-group-header">
                  <span>{t("waiting", locale)}</span>
                  <span className="tempo-group-count">{waitingTasks.length}</span>
                </div>
                {waitingTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    locale={locale}
                    project={task.projectId ? projects[task.projectId] : undefined}
                    subtasks={childrenMap.get(task.id) ?? []}
                    childrenMap={childrenMap}
                    focusState={activeFocus?.taskId === task.id ? activeFocus.state : null}
                    isSelected={selectedTaskId === task.id}
                    onSelect={() => onSelectTask(task.id)}
                    onToggleStatus={() => onToggleStatus(task.id)}
                  />
                ))}
              </div>
            )}

            {/* Completed Group */}
            {doneTasks.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div className="tempo-group-header">
                  <span>{t("completedToday", locale)}</span>
                  <span className="tempo-group-count">{doneTasks.length}</span>
                </div>
                {doneTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    locale={locale}
                    project={task.projectId ? projects[task.projectId] : undefined}
                    subtasks={childrenMap.get(task.id) ?? []}
                    childrenMap={childrenMap}
                    focusState={activeFocus?.taskId === task.id ? activeFocus.state : null}
                    isSelected={selectedTaskId === task.id}
                    onSelect={() => onSelectTask(task.id)}
                    onToggleStatus={() => onToggleStatus(task.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
