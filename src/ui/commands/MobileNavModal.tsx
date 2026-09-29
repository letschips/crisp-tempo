import type { JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { getCycleTimeStatus, getProgress } from "../../core/selectors";
import type { Cycle, Project, Task } from "../../core/types";
import { t, type Locale } from "../../services/i18n";
import { CloseIcon, CycleIcon, FolderIcon, PlusIcon } from "../icons/Icons";

interface MobileNavModalProps {
  isOpen: boolean;
  onClose: () => void;
  locale: Locale;
  activeNav: string;
  onSelectNav: (nav: string) => void;
  projects: Record<string, Project>;
  cycles: Record<string, Cycle>;
  tasks: Record<string, Task>;
  onOpenNewProject: () => void;
  onOpenNewCycle: () => void;
}

export function MobileNavModal({
  isOpen,
  onClose,
  locale,
  activeNav,
  onSelectNav,
  projects,
  cycles,
  tasks,
  onOpenNewProject,
  onOpenNewCycle,
}: MobileNavModalProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  // The close handler is stored in a ref so the effect below can depend on `isOpen` alone.
  // Depending on the callback re-ran it on every parent render, which yanked focus back to
  // the first button while the user was interacting with the list.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!isOpen || !dialogRef.current) return;
    const dialog = dialogRef.current;
    const doc = dialog.ownerDocument;
    const ownerWindow = doc.defaultView ?? window;
    const previousFocus = doc.activeElement as HTMLElement | null;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])'
    )).filter((el) => el.getClientRects().length > 0 && !el.hasAttribute("disabled"));
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === "Tab") {
        const items = focusable();
        if (items.length === 0) return;
        const active = doc.activeElement;
        if (!dialog.contains(active) || (e.shiftKey && active === items[0]) ||
            (!e.shiftKey && active === items[items.length - 1])) {
          e.preventDefault();
          (e.shiftKey ? items[items.length - 1] : items[0]).focus();
        }
      }
    };
    ownerWindow.addEventListener("keydown", handleKeyDown, true);
    focusable()[0]?.focus();
    return () => {
      ownerWindow.removeEventListener("keydown", handleKeyDown, true);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const projectList = Object.values(projects);
  const cycleList = Object.values(cycles).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const allTasks = Object.values(tasks);

  return (
    <div
      className="tempo-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="tempo-window-card tempo-mobile-nav-modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("projectsAndCycles", locale)}
      >
        {/* Header */}
        <div className="tempo-window-header">
          <div className="tempo-window-title-left">
            <FolderIcon size={16} />
            <span className="tempo-window-title">{t("projectsAndCycles", locale)}</span>
          </div>
          <button
            type="button"
            className="tempo-window-close-btn"
            onClick={onClose}
            title={t("closeBtn", locale)}
          >
            <CloseIcon size={14} />
          </button>
        </div>

        {/* Body */}
        <div
          className="tempo-window-body"
          style={{ padding: "14px 16px" }}
        >
          {/* Quick System Navigation Pills */}
          <div style={{ marginBottom: 16 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--text-faint)",
                marginBottom: 8,
                letterSpacing: "0.02em",
              }}
            >
              {t("viewsLabel", locale)}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {[
                { key: "inbox", label: t("inbox", locale) },
                { key: "today", label: t("today", locale) },
                { key: "upcoming", label: t("upcoming", locale) },
                { key: "anytime", label: t("anytime", locale) },
                { key: "someday", label: t("someday", locale) },
                { key: "waiting", label: t("waiting", locale) },
                { key: "completed", label: t("completed", locale) },
              ].map((v) => (
                <button
                  key={v.key}
                  type="button"
                  className={`tempo-pill-btn ${activeNav === v.key ? "is-active" : ""}`}
                  onClick={() => {
                    onSelectNav(v.key);
                    onClose();
                  }}
                  style={{ fontSize: 12, padding: "4px 10px" }}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>

          {/* Projects Section */}
          <div style={{ marginBottom: 18 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--text-faint)",
                  letterSpacing: "0.02em",
                }}
              >
                {t("projects", locale).toUpperCase()} ({projectList.length})
              </span>
              <button
                type="button"
                className="tempo-action-btn"
                onClick={onOpenNewProject}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 11.5,
                  padding: "3px 8px",
                  borderRadius: 6,
                }}
              >
                <PlusIcon size={11} />
                <span>{t("newProject", locale)}</span>
              </button>
            </div>

            {projectList.length === 0 ? (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-faint)",
                  padding: "12px 8px",
                  textAlign: "center",
                }}
              >
                {t("noProjectsPrompt", locale)}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {projectList.map((proj) => {
                  const projTasks = allTasks.filter(
                    (t) => t.projectId === proj.id && !t.parentTaskId
                  );
                  const { done: doneTasks, total, pct } = getProgress(projTasks);
                  const activeCount = total - doneTasks;
                  const isActive = activeNav === `proj:${proj.id}`;

                  return (
                    <button
                      type="button"
                      key={proj.id}
                      className={`tempo-nav-item tempo-mobile-nav-project-item ${isActive ? "is-active" : ""}`}
                      onClick={() => {
                        onSelectNav(`proj:${proj.id}`);
                        onClose();
                      }}
                      style={{
                        padding: "8px 10px",
                        borderRadius: 8,
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        cursor: "pointer",
                        width: "100%",
                        textAlign: "left",
                        fontFamily: "inherit",
                      }}
                    >
                      <span
                        className="tempo-project-dot"
                        style={{
                          backgroundColor: proj.color || "var(--interactive-accent)",
                          width: 8,
                          height: 8,
                          flexShrink: 0,
                        }}
                      />
                      <span
                        className="tempo-nav-title"
                        style={{ flex: 1, fontSize: 13, fontWeight: 500 }}
                      >
                        {proj.title || t("untitledProject", locale)}
                      </span>
                      <span
                        className="tempo-nav-badge"
                        style={{ fontSize: 10, padding: "2px 6px" }}
                      >
                        {activeCount > 0 ? `${activeCount} ${t("openTasksSuffix", locale)}` : `${pct}%`}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Cycles Section */}
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--text-faint)",
                  letterSpacing: "0.02em",
                }}
              >
                {t("cycles", locale).toUpperCase()} ({cycleList.length})
              </span>
              <button
                type="button"
                className="tempo-action-btn"
                onClick={onOpenNewCycle}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 11.5,
                  padding: "3px 8px",
                  borderRadius: 6,
                }}
              >
                <PlusIcon size={11} />
                <span>{t("newCycle", locale)}</span>
              </button>
            </div>

            {cycleList.length === 0 ? (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-faint)",
                  padding: "12px 8px",
                  textAlign: "center",
                }}
              >
                {t("noCyclesPrompt", locale)}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {cycleList.map((cycle) => {
                  const isActive = activeNav === `cycle:${cycle.id}`;
                  return (
                    <button
                      type="button"
                      key={cycle.id}
                      className={`tempo-nav-item ${isActive ? "is-active" : ""}`}
                      onClick={() => {
                        onSelectNav(`cycle:${cycle.id}`);
                        onClose();
                      }}
                      style={{
                        padding: "8px 10px",
                        borderRadius: 8,
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        cursor: "pointer",
                        width: "100%",
                        textAlign: "left",
                        fontFamily: "inherit",
                      }}
                    >
                      <span className="tempo-nav-icon">
                        <CycleIcon size={14} />
                      </span>
                      <div
                        style={{
                          flex: 1,
                          minWidth: 0,
                          display: "flex",
                          flexDirection: "column",
                        }}
                      >
                        <span
                          className="tempo-nav-title"
                          style={{ fontSize: 13, fontWeight: 500 }}
                        >
                          {cycle.title}
                        </span>
                        <span style={{ fontSize: 10, color: "var(--text-faint)" }}>
                          {cycle.startDate} ~ {cycle.endDate}
                        </span>
                      </div>
                      {getCycleTimeStatus(cycle) === "current" && (
                        <span
                          className="tempo-nav-badge"
                          style={{
                            fontSize: 9,
                            fontWeight: 600,
                            color: "var(--tempo-ui-accent)",
                          }}
                        >
                          {t("cycleNowBadge", locale)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="tempo-window-footer" style={{ justifyContent: "space-between" }}>
          <button
            type="button"
            className="tempo-action-btn"
            onClick={() => {
              onSelectNav("today");
              onClose();
            }}
            style={{ fontSize: 12 }}
          >
            ← {t("backToToday", locale)}
          </button>
          <button
            type="button"
            className="tempo-btn-primary"
            onClick={onClose}
            style={{ fontSize: 12, padding: "5px 14px" }}
          >
            {t("doneBtn", locale)}
          </button>
        </div>
      </div>
    </div>
  );
}
