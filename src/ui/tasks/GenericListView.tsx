import type { JSX } from "preact";
import { getProgress } from "../../core/selectors";
import type { Project, Task } from "../../core/types";
import { t, tf, type Locale } from "../../services/i18n";
import { PlusIcon } from "../icons/Icons";
import { TaskRow } from "./TaskRow";

interface GenericListViewProps {
  title: string;
  subtitle: string;
  locale: Locale;
  tasks: Task[];
  /** Subtasks grouped by parent, built once by the caller instead of scanned per row. */
  childrenMap: Map<string, Task[]>;
  projects: Record<string, Project>;
  project?: Project;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onToggleStatus: (taskId: string) => void;
  onOpenQuickAdd: () => void;
  onBackToToday?: () => void;
  /** Opens the edit dialog of the project or cycle on screen. */
  onEdit?: () => void;
}

export function GenericListView({
  title,
  subtitle,
  locale,
  tasks,
  childrenMap,
  projects,
  project,
  selectedTaskId,
  onSelectTask,
  onToggleStatus,
  onOpenQuickAdd,
  onBackToToday,
  onEdit,
}: GenericListViewProps): JSX.Element {

  const { done: doneCount, total: progressTotal, pct: progressPct } = getProgress(tasks);

  return (
    <div className="tempo-main-card">
      <div className="tempo-card-header">
        <div className="tempo-card-header-left">
          {onBackToToday && (
            <button
              type="button"
              className="tempo-action-btn tempo-project-back-btn"
              onClick={onBackToToday}
              title={t("today", locale)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "3px 8px",
                fontSize: 11.5,
                marginRight: 6,
                borderRadius: 6,
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              ← {t("today", locale)}
            </button>
          )}
          <span className="tempo-card-title">{title}</span>
          {subtitle && (
            <span
              className="tempo-card-subtitle"
              style={{ minWidth: 0, flex: "0 1 auto", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}
            >
              {subtitle}
            </span>
          )}
          <span
            className="tempo-nav-badge"
            style={{ whiteSpace: "nowrap", flexShrink: 0, display: "inline-flex", alignItems: "center" }}
          >
            {tf("taskCount", locale, { n: tasks.length })}
          </span>
        </div>
        <div className="tempo-card-header-actions">
        {onEdit && (
          <button
            type="button"
            className="tempo-card-header-btn is-secondary"
            onClick={onEdit}
            title={t("editBtn", locale)}
          >
            <span>{t("editBtn", locale)}</span>
          </button>
        )}
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
      </div>

      {project && (
        <div style={{ padding: "10px 18px 6px", borderBottom: "1px solid var(--background-modifier-border)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {doneCount} / {progressTotal} {t("completed", locale)}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-normal)" }}>
              {progressPct}%
            </span>
          </div>
          <div style={{ width: "100%", height: 5, borderRadius: 3, background: "var(--background-modifier-border)", overflow: "hidden" }}>
            <div
              style={{
                width: `${progressPct}%`,
                height: "100%",
                background: project.color || "var(--interactive-accent)",
                transition: "width 0.3s ease",
              }}
            />
          </div>
        </div>
      )}

      <div className="tempo-task-scroll">
        {tasks.length === 0 ? (
          <div className="tempo-empty-state">
            <p style={{ margin: 0, fontWeight: 500 }}>{t("noTasksInView", locale)}</p>
          </div>
        ) : (
          tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              locale={locale}
              project={task.projectId ? projects[task.projectId] : undefined}
              subtasks={childrenMap.get(task.id) ?? []}
              isSelected={selectedTaskId === task.id}
              onSelect={() => onSelectTask(task.id)}
              onToggleStatus={() => onToggleStatus(task.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
