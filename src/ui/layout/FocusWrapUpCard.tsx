import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { FocusWrapUp } from "../../core/store";
import type { Task } from "../../core/types";
import { t, tf, type Locale } from "../../services/i18n";
import { CloseIcon } from "../icons/Icons";

interface FocusWrapUpCardProps {
  task: Task;
  wrapUp: FocusWrapUp;
  locale: Locale;
  /** Saves the next step (empty clears it) and closes the card. */
  onSave: (nextStep: string | undefined) => void;
  onDismiss: () => void;
}

/**
 * After a focus session on a task ends: one line to note where to pick up. Never blocks anything;
 * closing it changes nothing.
 */
export function FocusWrapUpCard({ task, wrapUp, locale, onSave, onDismiss }: FocusWrapUpCardProps): JSX.Element {
  const [draft, setDraft] = useState(task.nextStep ?? "");
  const save = () => onSave(draft.trim() || undefined);
  return (
    <div className="tempo-wrapup-card" role="region" aria-label={t("nextStep", locale)}>
      <span className="tempo-wrapup-text">
        {tf(wrapUp.completed ? "wrapUpCompleted" : "wrapUpInterrupted", locale, { title: task.title, m: wrapUp.minutes })}
      </span>
      <input
        type="text"
        className="tempo-property-input tempo-wrapup-input"
        value={draft}
        placeholder={t("nextStepPlaceholder", locale)}
        aria-label={t("nextStep", locale)}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.isComposing || (e as any).keyCode === 229) return;
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            e.stopPropagation();
            onDismiss();
          }
        }}
      />
      <button type="button" className="tempo-action-btn tempo-wrapup-save" onClick={save}>
        {t("saveBtn", locale)}
      </button>
      <button
        type="button"
        className="tempo-action-btn tempo-wrapup-close"
        onClick={onDismiss}
        aria-label={t("closeBtn", locale)}
        title={t("closeBtn", locale)}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
