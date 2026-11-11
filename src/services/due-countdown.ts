import { t, tf, type Locale } from "./i18n";

/** Label for an open task's due date, given whole days left (negative once overdue). */
export function formatDueCountdown(days: number, locale: Locale): string {
  if (days < 0) return tf("dueCountdownOverdue", locale, { n: -days });
  if (days === 0) return t("dueCountdownToday", locale);
  if (days === 1) return t("dueCountdownTomorrow", locale);
  return tf("dueCountdownDays", locale, { n: days });
}
