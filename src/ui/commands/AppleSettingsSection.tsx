import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { AppleSettings } from "../../core/apple-sync";
import type { AppleAccess, AppleActions, AppleCalendarInfo, AppleRuntime } from "../../core/store";
import { t, tf, type Locale } from "../../services/i18n";

export interface AppleSettingsSectionProps {
  locale: Locale;
  runtime: AppleRuntime;
  settings: AppleSettings;
  actions: AppleActions;
  licensed: boolean;
  onUpdateSettings: (updater: (prev: AppleSettings) => AppleSettings) => void;
}

type Kind = "reminders" | "calendar";

function Toggle({ on, busy, label, onChange }: { on: boolean; busy: boolean; label: string; onChange: (on: boolean) => void }): JSX.Element {
  return (
    <div
      className={`checkbox-container tempo-apple-toggle ${on ? "is-enabled" : ""} ${busy ? "is-busy" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      tabIndex={0}
      onClick={() => !busy && onChange(!on)}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          if (!busy) onChange(!on);
        }
      }}
    >
      <input type="checkbox" checked={on} tabIndex={-1} aria-hidden="true" />
    </div>
  );
}

function OptionList({
  items,
  isChecked,
  onToggle,
}: {
  items: AppleCalendarInfo[];
  isChecked: (id: string) => boolean;
  onToggle: (id: string, checked: boolean) => void;
}): JSX.Element {
  return (
    <div className="tempo-apple-options">
      {items.map((item) => (
        <label key={item.id} className="tempo-apple-option">
          <input
            type="checkbox"
            checked={isChecked(item.id)}
            onChange={(e) => onToggle(item.id, (e.target as HTMLInputElement).checked)}
          />
          <span className="tempo-apple-dot" style={item.color ? { background: item.color } : undefined} />
          <span className="tempo-apple-option-title">{item.title}</span>
          {item.source && <span className="tempo-apple-option-source">{item.source}</span>}
        </label>
      ))}
    </div>
  );
}

const blocked = (state: AppleAccess | undefined) => state === "denied" || state === "restricted" || state === "writeOnly";

export function AppleSettingsSection({ locale, runtime, settings, actions, licensed, onUpdateSettings }: AppleSettingsSectionProps): JSX.Element {
  const [busy, setBusy] = useState<Kind | null>(null);
  const toggle = async (kind: Kind, on: boolean) => {
    setBusy(kind);
    try {
      await actions.setEnabled(kind, on);
    } finally {
      setBusy(null);
    }
  };
  const remindersOn = !!settings.remindersEnabled && runtime.reminders === "fullAccess";
  const calendarOn = !!settings.calendarEnabled && runtime.calendar === "fullAccess";
  const chosenLists = new Set(settings.reminderLists ?? []);
  const hidden = new Set(settings.hiddenCalendars ?? []);
  const lastSync = runtime.lastSync;

  const denied = (kind: Kind) => (
    <div className="tempo-settings-item-desc tempo-apple-denied">
      <span>{tf("appleDenied", locale, { what: t(kind === "reminders" ? "appleReminders" : "appleCalendar", locale) })}</span>
      <button type="button" className="tempo-action-btn" onClick={() => actions.openPrivacySettings(kind)}>
        {t("appleOpenSettings", locale)}
      </button>
    </div>
  );

  return (
    <div className="tempo-settings-section tempo-apple-section" style={{ marginTop: 20 }}>
      <div className="tempo-settings-section-title">{t("appleSection", locale)}</div>

      {runtime.error && <div className="tempo-settings-alert-error" role="alert" style={{ marginBottom: 10 }}>⚠ {runtime.error}</div>}

      {/* Reminders */}
      <div className="tempo-settings-item">
        <div className="tempo-settings-label-group">
          <span className="tempo-settings-item-title">{t("appleReminders", locale)}</span>
          <span className="tempo-settings-item-desc">{t("appleRemindersDesc", locale)}</span>
        </div>
        <Toggle on={remindersOn} busy={busy === "reminders"} label={t("appleReminders", locale)} onChange={(on) => void toggle("reminders", on)} />
      </div>
      {blocked(runtime.reminders) && denied("reminders")}
      {remindersOn && (
        <div className="tempo-apple-detail">
          <div className="tempo-apple-subtitle">{t("appleImportLists", locale)}</div>
          {runtime.reminderLists ? (
            <OptionList
              items={runtime.reminderLists}
              isChecked={(id) => chosenLists.has(id)}
              onToggle={(id, checked) => {
                onUpdateSettings((prev) => {
                  const next = new Set(prev.reminderLists ?? []);
                  if (checked) next.add(id);
                  else next.delete(id);
                  return { ...prev, reminderLists: [...next] };
                });
                void actions.syncNow();
              }}
            />
          ) : (
            <div className="tempo-settings-item-desc">{t("loading", locale)}</div>
          )}
          {!licensed && <div className="tempo-settings-item-desc">{t("appleNeedLicense", locale)}</div>}

          {runtime.reminderLists && runtime.reminderLists.length > 1 && (
            <div className="tempo-settings-item" style={{ marginTop: 10 }}>
              <div className="tempo-settings-label-group">
                <span className="tempo-settings-item-title">{t("appleSendList", locale)}</span>
              </div>
              <select
                className="dropdown tempo-apple-select"
                value={settings.sendListId ?? ""}
                onChange={(e) => {
                  const value = (e.target as HTMLSelectElement).value;
                  onUpdateSettings((prev) => ({ ...prev, sendListId: value || undefined }));
                }}
              >
                <option value="">{t("appleDefaultList", locale)}</option>
                {runtime.reminderLists.map((list) => (
                  <option key={list.id} value={list.id}>{list.title}</option>
                ))}
              </select>
            </div>
          )}

          <div className="tempo-apple-sync-row">
            <span className="tempo-settings-item-desc">
              {runtime.syncing
                ? t("appleSyncing", locale)
                : lastSync
                  ? lastSync.ok
                    ? tf("appleLastSync", locale, { time: new Date(lastSync.at).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" }) })
                    : tf("appleLastSyncFailed", locale, { reason: lastSync.message ?? "" })
                  : ""}
            </span>
            <button type="button" className="tempo-action-btn" disabled={runtime.syncing} onClick={() => void actions.syncNow()}>
              {t("appleSyncNow", locale)}
            </button>
          </div>
        </div>
      )}

      {/* Calendar */}
      <div className="tempo-settings-item" style={{ marginTop: 14 }}>
        <div className="tempo-settings-label-group">
          <span className="tempo-settings-item-title">{t("appleCalendar", locale)}</span>
          <span className="tempo-settings-item-desc">{t("appleCalendarDesc", locale)}</span>
        </div>
        <Toggle on={calendarOn} busy={busy === "calendar"} label={t("appleCalendar", locale)} onChange={(on) => void toggle("calendar", on)} />
      </div>
      {blocked(runtime.calendar) && denied("calendar")}
      {calendarOn && runtime.calendars && runtime.calendars.length > 0 && (
        <div className="tempo-apple-detail">
          <div className="tempo-apple-subtitle">{t("appleShowCalendars", locale)}</div>
          <OptionList
            items={runtime.calendars}
            isChecked={(id) => !hidden.has(id)}
            onToggle={(id, checked) => {
              onUpdateSettings((prev) => {
                const next = new Set(prev.hiddenCalendars ?? []);
                if (checked) next.delete(id);
                else next.add(id);
                return { ...prev, hiddenCalendars: [...next] };
              });
              void actions.syncNow();
            }}
          />
        </div>
      )}
    </div>
  );
}
