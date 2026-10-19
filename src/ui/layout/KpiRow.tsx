import type { JSX } from "preact";
import type { KpiStats } from "../../core/selectors";
import { t, tf, type Locale } from "../../services/i18n";

interface KpiRowProps {
  stats: KpiStats;
  locale: Locale;
  activeNav: string;
  onSelectNav: (nav: string) => void;
}

export function KpiRow({ stats, locale, activeNav, onSelectNav }: KpiRowProps): JSX.Element {
  // `highlight` is deliberately separate from `nav`: two cards may share a destination, but
  // only the card that represents that destination is marked active. The completed card
  // counts today only while its destination is the full archive, so its subtitle says so.
  const kpis = [
    {
      key: "today",
      nav: "today",
      highlight: "today",
      label: t("todayKpi", locale),
      val: tf("taskCount", locale, { n: stats.todayRemaining }),
      sub: t("today", locale),
    },
    {
      key: "in-progress",
      nav: "today",
      highlight: null,
      label: t("inProgressKpi", locale),
      val: tf("taskCount", locale, { n: stats.inProgress }),
      sub: t("inProgress", locale),
    },
    {
      key: "inbox",
      nav: "inbox",
      highlight: "inbox",
      label: t("inboxKpi", locale),
      val: tf("taskCount", locale, { n: stats.inbox }),
      sub: t("inboxSubtitle", locale),
    },
    {
      key: "done-today",
      nav: "completed",
      highlight: "completed",
      label: t("doneKpi", locale),
      val: tf("taskCount", locale, { n: stats.todayDone }),
      sub: t("completedLog", locale),
    },
  ];

  return (
    <div className="tempo-kpi-row">
      {kpis.map((kpi) => (
        <div
          key={kpi.key}
          className={`tempo-kpi-card ${kpi.highlight && activeNav === kpi.highlight ? "is-active" : ""}`}
          onClick={() => onSelectNav(kpi.nav)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelectNav(kpi.nav);
            }
          }}
          role="button"
          tabIndex={0}
        >
          <div className="tempo-kpi-label">{kpi.label}</div>
          <div className="tempo-kpi-val">{kpi.val}</div>
          <div className="tempo-kpi-sub">{kpi.sub}</div>
        </div>
      ))}
    </div>
  );
}
