import type { JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Project, TaskPriority } from "../../core/types";
import { getTodayString } from "../../services/date-service";
import { t, type Locale } from "../../services/i18n";
import { installDialogFocus } from "../components/dialog-focus";
import { DatePickerPopover } from "../components/DatePickerPopover";
import {
  CloseIcon,
  InboxIcon,
  TempoLogoIcon,
  TodayIcon,
} from "../icons/Icons";

export interface TaskCreateModalProps {
  isOpen: boolean;
  locale: Locale;
  projects: Record<string, Project>;
  defaultDest?: "inbox" | "today";
  defaultProjectId?: string;
  defaultCycleId?: string;
  onClose: () => void;
  onAddTask: (task: {
    title: string;
    description?: string;
    triage: "inbox" | "processed";
    availability: "anytime" | "someday";
    priority: TaskPriority;
    focusDate?: string;
    startDate?: string;
    dueDate?: string;
    projectId?: string;
    cycleId?: string;
  }) => void;
}

export function TaskCreateModal({
  isOpen,
  locale,
  projects,
  defaultDest = "inbox",
  defaultProjectId,
  defaultCycleId,
  onClose,
  onAddTask,
}: TaskCreateModalProps): JSX.Element | null {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dest, setDest] = useState<"inbox" | "today">(defaultDest);
  const [projectId, setProjectId] = useState<string>(defaultProjectId || "");
  const [priority, setPriority] = useState<TaskPriority>("none");
  const [dueDate, setDueDate] = useState<string | undefined>(undefined);
  const [startDate, setStartDate] = useState<string | undefined>(undefined);

  const titleInputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const removeKeyboard = installDialogFocus(card, onClose);
    const focusTimer = setTimeout(() => titleInputRef.current?.focus(), 60);
    return () => {
      clearTimeout(focusTimer);
      removeKeyboard();
    };
  }, []);

  const isSubmittingRef = useRef(false);

  const handleSubmit = () => {
    if (isSubmittingRef.current) return;
    const trimmed = title.trim();
    if (!trimmed) return;

    isSubmittingRef.current = true;
    onAddTask({
      title: trimmed,
      description: description.trim() || undefined,
      // A planned start is a decision about when, so the task skips the inbox; on or after that
      // day it is on Today without needing a focus date.
      triage: dest === "today" || startDate ? "processed" : "inbox",
      availability: "anytime",
      priority,
      focusDate: dest === "today" && !startDate ? getTodayString() : undefined,
      startDate,
      dueDate,
      projectId: projectId || undefined,
      cycleId: defaultCycleId,
    });

    onClose();
  };

  const handleTitleKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || (e as any).keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      handleSubmit();
    }
  };

  const handleGlobalCardKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || (e as any).keyCode === 229 || e.defaultPrevented) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      handleSubmit();
    }
  };

  // The guard sits after every hook so the hook order cannot change between renders.
  if (!isOpen) return null;

  return (
    <div
      className="tempo-modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="tempo-window-card" ref={cardRef} onKeyDown={handleGlobalCardKeyDown}>
        {/* Window Titlebar */}
        <div className="tempo-window-header">
          <div className="tempo-window-title-left">
            <TempoLogoIcon size={16} />
            <span className="tempo-window-title">{t("newTask", locale)}</span>
            <span className="tempo-window-badge">⌘⇧␣ / C</span>
          </div>
          <button
            type="button"
            className="tempo-window-close-btn"
            onClick={onClose}
            title={`${t("closeBtn", locale)} (Esc)`}
          >
            <CloseIcon size={13} />
          </button>
        </div>

        {/* Window Body */}
        <div className="tempo-window-body">
          {/* Main Title Input */}
          <div className="tempo-window-field">
            <input
              ref={titleInputRef}
              type="text"
              className="tempo-window-input-title"
              placeholder={t("titlePlaceholder", locale)}
              value={title}
              onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
              onKeyDown={handleTitleKeyDown}
            />
          </div>

          {/* Description Textarea */}
          <div className="tempo-window-field">
            <textarea
              className="tempo-window-textarea"
              rows={2}
              placeholder={t("descPlaceholder", locale)}
              value={description}
              onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
            />
          </div>

          {/* Properties Row */}
          <div className="tempo-window-props-row">
            {/* Destination Toggle */}
            <div className="tempo-window-prop-group">
              <button
                type="button"
                className={`tempo-pill-btn ${dest === "inbox" ? "is-active" : ""}`}
                onClick={() => setDest("inbox")}
              >
                <InboxIcon size={13} />
                <span>{t("inbox", locale)}</span>
              </button>
              <button
                type="button"
                className={`tempo-pill-btn ${dest === "today" ? "is-active" : ""}`}
                onClick={() => setDest("today")}
              >
                <TodayIcon size={13} />
                <span>{t("today", locale)}</span>
              </button>
            </div>

            {/* Project Dropdown */}
            <div className="tempo-window-prop-group">
              <select
                className="tempo-property-select"
                value={projectId}
                onChange={(e) => setProjectId((e.target as HTMLSelectElement).value)}
                style={{ minWidth: 120 }}
              >
                <option value="">{t("noProject", locale)}</option>
                {Object.values(projects).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </div>

            {/* Priority Selector */}
            <div className="tempo-window-prop-group">
              <select
                className="tempo-property-select"
                value={priority}
                onChange={(e) => setPriority((e.target as HTMLSelectElement).value as TaskPriority)}
                style={{ minWidth: 95 }}
              >
                <option value="none">{t("priorityNone", locale)}</option>
                <option value="low">{t("priorityLow", locale)}</option>
                <option value="medium">{t("priorityMedium", locale)}</option>
                <option value="high">{t("priorityHigh", locale)}</option>
                <option value="urgent">{t("priorityUrgent", locale)}</option>
              </select>
            </div>

            {/* Planned start and deadline are separate dates */}
            <div className="tempo-window-prop-group tempo-start-date-field">
              <DatePickerPopover
                value={startDate}
                locale={locale}
                placement="top"
                align="auto"
                placeholder={t("planStartDate", locale)}
                onChange={(date) => setStartDate(date)}
              />
            </div>
            <div className="tempo-window-prop-group">
              <DatePickerPopover
                value={dueDate}
                locale={locale}
                placement="top"
                align="auto"
                placeholder={t("dueDate", locale)}
                onChange={(date) => setDueDate(date)}
              />
            </div>
          </div>
        </div>

        {/* Window Footer */}
        <div className="tempo-window-footer">
          <div className="tempo-window-hint">{t("shortcutHint", locale)}</div>
          <div className="tempo-window-actions">
            <button
              type="button"
              className="tempo-action-btn"
              onClick={onClose}
            >
              {t("cancelBtn", locale)}
            </button>
            <button
              type="button"
              className="tempo-btn-primary"
              onClick={handleSubmit}
              disabled={!title.trim()}
            >
              {t("createBtn", locale)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
