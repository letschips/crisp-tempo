import { useState } from "preact/hooks";
import type { JSX } from "preact";
import type { Cycle, Project, Task } from "../../core/types";
import type { NavCounts } from "../../core/selectors";
import { t, type Locale } from "../../services/i18n";
import { CycleIcon, FolderIcon, PlusIcon, SettingsIcon, TempoLogoIcon } from "../icons/Icons";

interface HeaderProps {
  locale: Locale;
  activeNav: string;
  tasks: Record<string, Task>;
  counts: NavCounts;
  projects?: Record<string, Project>;
  cycles?: Record<string, Cycle>;
  onSelectNav: (nav: string) => void;
  onOpenSettings: () => void;
  onUndo: () => void;
  onOpenQuickAdd: () => void;
  onOpenProjects?: () => void;
  isLicensed?: boolean;
  onOpenLicense?: () => void;
  onMoveTaskToBucket?: (taskId: string, bucket: string) => void;
}

export function Header({
  locale,
  activeNav,
  tasks,
  counts,
  projects = {},
  cycles = {},
  onSelectNav,
  onOpenSettings,
  onUndo,
  onOpenQuickAdd,
  onOpenProjects,
  isLicensed = true,
  onOpenLicense,
  onMoveTaskToBucket,
}: HeaderProps): JSX.Element {
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  const activeProject = activeNav.startsWith("proj:")
    ? projects[activeNav.replace("proj:", "")]
    : null;
  const activeCycle = activeNav.startsWith("cycle:")
    ? cycles[activeNav.replace("cycle:", "")]
    : null;

  interface NavPill {
    key: string;
    label: string;
    icon: JSX.Element | null;
    count: number;
  }

  const navPills: NavPill[] = [
    { key: "inbox", label: t("inbox", locale), icon: null, count: counts.inbox },
    { key: "today", label: t("today", locale), icon: null, count: counts.today },
    { key: "upcoming", label: t("upcoming", locale), icon: null, count: counts.upcoming },
    { key: "anytime", label: t("anytime", locale), icon: null, count: counts.anytime },
    { key: "someday", label: t("someday", locale), icon: null, count: counts.someday },
    { key: "waiting", label: t("waiting", locale), icon: null, count: counts.waiting },
    { key: "completed", label: t("completed", locale), icon: null, count: counts.completed },
  ];

  // If currently viewing a project, include active project pill
  if (activeProject) {
    // Same scope as the project list and the cycle pill: open top-level tasks only.
    const projTasks = Object.values(tasks).filter(
      (t) =>
        t.projectId === activeProject.id &&
        !t.parentTaskId &&
        t.status !== "done" &&
        t.status !== "canceled"
    );
    navPills.push({
      key: `proj:${activeProject.id}`,
      label: activeProject.title,
      icon: <span className="tempo-pill-icon"><FolderIcon size={12} /></span>,
      count: projTasks.length,
    });
  }

  // If currently viewing a cycle, include active cycle pill with its own task count.
  if (activeCycle) {
    const cycleTasks = Object.values(tasks).filter(
      (t) =>
        t.cycleId === activeCycle.id &&
        !t.parentTaskId &&
        t.status !== "done" &&
        t.status !== "canceled"
    );
    navPills.push({
      key: `cycle:${activeCycle.id}`,
      label: activeCycle.title,
      icon: <span className="tempo-pill-icon"><CycleIcon size={12} /></span>,
      count: cycleTasks.length,
    });
  }

  return (
    <header className="tempo-header">
      {/* 1. Header Top Bar: Brand on Left, Actions on Right */}
      <div className="tempo-header-top">
        <div className="tempo-title-group">
          <div className="tempo-title-icon">
            <TempoLogoIcon size={19} />
          </div>
          <h1 className="tempo-title">
            <span>{t("appName", locale)}</span>
          </h1>
        </div>

        {/* Global Action Tools */}
        <div className="tempo-header-actions">
          {!isLicensed && onOpenLicense && (
            <button
              type="button"
              className="tempo-license-chip"
              onClick={onOpenLicense}
              title={t("licenseRequiredNotice", locale)}
            >
              {t("licenseChip", locale)}
            </button>
          )}
          {/* Settings Button */}
          <button
            type="button"
            className="tempo-action-btn"
            onClick={onOpenSettings}
            title={t("settings", locale)}
            aria-label={t("settings", locale)}
          >
            <SettingsIcon size={13} />
            <span>{t("settings", locale)}</span>
          </button>

          {/* Undo Button */}
          <button
            type="button"
            className="tempo-action-btn"
            onClick={onUndo}
            title={t("undoBtn", locale)}
            aria-label={t("undoBtn", locale)}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 7v6h6" />
              <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
            </svg>
            <span>{t("undoBtn", locale)}</span>
          </button>

          {onOpenProjects && (
            <button type="button" className="tempo-action-btn tempo-projects-entry"
              onClick={onOpenProjects} title={t("projectsAndCycles", locale)}
              aria-label={t("projectsAndCycles", locale)}>
              <FolderIcon size={15} />
            </button>
          )}

          {/* New Task Button */}
          <button
            type="button"
            className="tempo-btn-primary"
            onClick={onOpenQuickAdd}
            title={`${t("newTask", locale)} (C)`}
          >
            <PlusIcon size={13} />
            <span>{t("newTask", locale)}</span>
          </button>
        </div>
      </div>

      {/* 2. Nav Pills (Crisp Pulse Tab style with Drag & Drop target capability) */}
      <div className="tempo-nav-pills">
        {navPills.map((pill) => (
          <button
            key={pill.key}
            type="button"
            className={`tempo-pill-btn ${activeNav === pill.key ? "is-active" : ""} ${
              dragOverKey === pill.key ? "is-drag-over" : ""
            }`}
            onClick={() => onSelectNav(pill.key)}
            onDragOver={(e) => {
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
              if (dragOverKey !== pill.key) setDragOverKey(pill.key);
            }}
            onDragLeave={() => {
              if (dragOverKey === pill.key) setDragOverKey(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverKey(null);
              const taskId =
                e.dataTransfer?.getData("application/x-tempo-task-id") ||
                e.dataTransfer?.getData("text/plain");
              if (taskId && onMoveTaskToBucket) {
                onMoveTaskToBucket(taskId, pill.key);
              }
            }}
          >
            {pill.icon}
            <span>{pill.label}</span>
            {pill.count > 0 && <span className="tempo-pill-count">{pill.count}</span>}
          </button>
        ))}

      </div>
    </header>
  );
}
