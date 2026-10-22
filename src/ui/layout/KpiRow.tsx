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
  // only the card that represents that destination is marked active.
  const kpis = [
    {
      key: "today",
      nav: "today",
      highlight: "today",
      label: t("todayKpi", locale),
      val: tf("taskCount", locale, { n: stats.todayRemaining }),
    },
    {
      key: "in-progress",
      nav: "today",
      highlight: null,
      label: t("inProgressKpi", locale),
      val: tf("taskCount", locale, { n: stats.inProgress }),
    },
    {
      key: "inbox",
      nav: "inbox",
      highlight: "inbox",
      label: t("inboxKpi", locale),
      val: tf("taskCount", locale, { n: stats.inbox }),
    },
    {
      key: "done-today",
      nav: "completed",
      highlight: "completed",
      label: t("doneKpi", locale),
      val: tf("taskCount", locale, { n: stats.todayDone }),
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
        </div>
      ))}
    </div>
  );
}
