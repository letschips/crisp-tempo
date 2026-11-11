import type { Locale } from "./i18n";

export function getTodayString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getTomorrowString(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getOffsetDateString(daysOffset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatHeaderDate(date: Date = new Date(), locale: Locale = "zh"): string {
  if (locale === "zh") {
    const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const weekday = weekdays[date.getDay()];
    return `${year}年${month}月${day}日 ${weekday}`;
  }
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function formatDateDisplay(dateStr?: string, locale: Locale = "zh"): string {
  if (!dateStr) return "";
  const today = getTodayString();
  const tomorrow = getTomorrowString();

  if (dateStr === today) return locale === "zh" ? "今天" : "Today";
  if (dateStr === tomorrow) return locale === "zh" ? "明天" : "Tomorrow";

  const [year, month, day] = dateStr.split("-").map(Number);
  if (locale === "zh") {
    return `${month}月${day}日`;
  }
  const date = new Date(year, month - 1, day);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function isOverdue(dueDate?: string): boolean {
  if (!dueDate) return false;
  return dueDate < getTodayString();
}

/** Whole calendar days from `today` to `dateStr`: 0 on the day, negative once it has passed.
    Counted on UTC midnights so a daylight-saving change never turns a day into 0.96 days. */
export function daysUntil(dateStr: string, today: string = getTodayString()): number {
  const toUtc = (value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(dateStr) - toUtc(today)) / 86_400_000);
}

/** Days at or under this count as "due soon" and get the warning colour. */
export const DUE_SOON_DAYS = 3;
