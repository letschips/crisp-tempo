import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { getTodayString, getTomorrowString } from "../../services/date-service";
import { t, type Locale } from "../../services/i18n";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon } from "../icons/Icons";

interface DatePickerPopoverProps {
  value?: string; // YYYY-MM-DD
  locale: Locale;
  onChange: (dateStr: string | undefined) => void;
  placement?: "top" | "bottom" | "auto";
  align?: "left" | "right" | "auto";
  /** Shown while no date is set; defaults to "select a date". */
  placeholder?: string;
}

export function DatePickerPopover({
  value,
  locale,
  onChange,
  placement = "auto",
  align = "auto",
  placeholder,
}: DatePickerPopoverProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const openRef = useRef(false);
  const closePopover = () => {
    openRef.current = false;
    setIsOpen(false);
  };
  const [actualPlacement, setActualPlacement] = useState<"top" | "bottom">("bottom");
  const [actualAlign, setActualAlign] = useState<"left" | "right">("right");
  const containerRef = useRef<HTMLDivElement>(null);
  const [popoverStyle, setPopoverStyle] = useState<Record<string, string>>({});

  // Initialize display year and month from value or today
  const initialDate = value ? new Date(value + "T00:00:00") : new Date();
  const [currentYear, setCurrentYear] = useState(initialDate.getFullYear());
  const [currentMonth, setCurrentMonth] = useState(initialDate.getMonth()); // 0-indexed

  // Sync year/month with current value or today whenever value changes or popover opens
  useEffect(() => {
    const d = value ? new Date(value + "T00:00:00") : new Date();
    if (!isNaN(d.getTime())) {
      setCurrentYear(d.getFullYear());
      setCurrentMonth(d.getMonth());
    }
  }, [value, isOpen]);

  // Attach dismissal before the next input event after the popover appears.
  useLayoutEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closePopover();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openRef.current) {
        openRef.current = false;
        e.stopPropagation();
        e.preventDefault();
        setIsOpen(false);
      }
    };

    const doc = containerRef.current?.ownerDocument ?? document;
    const ownerWindow = doc.defaultView ?? window;
    const closeOnLayoutChange = () => closePopover();
    const closeOnOuterScroll = (event: Event) => {
      if (!containerRef.current?.contains(event.target as Node)) closePopover();
    };
    doc.addEventListener("mousedown", handleClickOutside);
    doc.addEventListener("keydown", handleKeyDown);
    ownerWindow.addEventListener("resize", closeOnLayoutChange);
    doc.addEventListener("scroll", closeOnOuterScroll, true);
    return () => {
      doc.removeEventListener("mousedown", handleClickOutside);
      doc.removeEventListener("keydown", handleKeyDown);
      ownerWindow.removeEventListener("resize", closeOnLayoutChange);
      doc.removeEventListener("scroll", closeOnOuterScroll, true);
    };
  }, [isOpen]);

  const todayStr = getTodayString();
  const tomorrowStr = getTomorrowString();

  const handlePrevMonth = (e: MouseEvent) => {
    e.stopPropagation();
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear((y) => y - 1);
    } else {
      setCurrentMonth((m) => m - 1);
    }
  };

  const handleNextMonth = (e: MouseEvent) => {
    e.stopPropagation();
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear((y) => y + 1);
    } else {
      setCurrentMonth((m) => m + 1);
    }
  };

  // Calendar calculations
  const firstDayOfMonth = new Date(currentYear, currentMonth, 1).getDay(); // 0 is Sunday
  // Convert so Monday is 0, Sunday is 6
  const startOffset = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(currentYear, currentMonth, 0).getDate();

  const weekdaysZh = ["一", "二", "三", "四", "五", "六", "日"];
  const weekdaysEn = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const weekdays = locale === "zh" ? weekdaysZh : weekdaysEn;

  const monthNamesEn = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const headerTitle =
    locale === "zh"
      ? `${currentYear}年 ${currentMonth + 1}月`
      : `${monthNamesEn[currentMonth]} ${currentYear}`;

  const formatPadded = (n: number) => (n < 10 ? `0${n}` : `${n}`);

  // Build calendar matrix
  const calendarCells = [];

  // 1. Previous month trailing days
  for (let i = startOffset - 1; i >= 0; i--) {
    const dayNum = daysInPrevMonth - i;
    calendarCells.push({
      day: dayNum,
      isCurrentMonth: false,
      dateStr: "",
    });
  }

  // 2. Current month days
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${currentYear}-${formatPadded(currentMonth + 1)}-${formatPadded(day)}`;
    calendarCells.push({
      day,
      isCurrentMonth: true,
      dateStr,
      isToday: dateStr === todayStr,
      isSelected: dateStr === value,
    });
  }

  // 3. Next month leading days (fill row to multiples of 7)
  const totalCells = Math.ceil(calendarCells.length / 7) * 7;
  const trailingCount = totalCells - calendarCells.length;
  for (let day = 1; day <= trailingCount; day++) {
    calendarCells.push({
      day,
      isCurrentMonth: false,
      dateStr: "",
    });
  }

  const handleToggle = () => {
    if (!isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const doc = containerRef.current.ownerDocument;
      const ownerWindow = doc.defaultView ?? window;
      const paneRect = containerRef.current.closest(
        ".tempo-window-body, .tempo-inspector-body, .tempo-view-container, .workspace-leaf-content"
      )?.getBoundingClientRect();
      const maxPopupHeight = Math.max(120, (paneRect?.height ?? ownerWindow.innerHeight) - 16);
      const estimatedHeight = Math.min(maxPopupHeight,
        272 + Math.max(0, calendarCells.length / 7 - 5) * 30 +
        (ownerWindow.innerWidth <= 820 ? calendarCells.length / 7 * 4 : 0));
      const spaceBelow = Math.min(ownerWindow.innerHeight, paneRect?.bottom ?? ownerWindow.innerHeight) - rect.bottom;
      const spaceAbove = rect.top - Math.max(0, paneRect?.top ?? 0);
      const spaceRight = ownerWindow.innerWidth - rect.left;

      let isTop = false;
      if (placement === "top") {
        isTop = true;
      } else if (placement === "bottom") {
        isTop = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
      } else {
        isTop = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
      }
      setActualPlacement(isTop ? "top" : "bottom");

      const style: Record<string, string> = {
        maxHeight: `${maxPopupHeight}px`, overflowY: "hidden",
      };
      if (isTop) {
        if (paneRect) {
          const parentRect = paneRect;
          const naturalTop = rect.top - 6 - estimatedHeight;
          const minAllowedTop = parentRect.top + 8;
          if (naturalTop < minAllowedTop) {
            const shiftDown = minAllowedTop - naturalTop;
            style.bottom = `calc(100% + 6px - ${shiftDown}px)`;
          }
        }
      }
      let determinedAlign: "left" | "right" = "left";
      if (align === "left") {
        if (spaceRight < 260 && rect.right >= 250) {
          determinedAlign = "right";
        } else {
          determinedAlign = "left";
        }
      } else if (align === "right") {
        if (rect.right < 250 && spaceRight >= 250) {
          determinedAlign = "left";
        } else {
          determinedAlign = "right";
        }
      } else {
        if (spaceRight >= 260) {
          determinedAlign = "left";
        } else {
          determinedAlign = "right";
        }
      }

      // Position within both the visible viewport and the Tempo pane.
      const leftBound = Math.max(8, (paneRect?.left ?? 0) + 8);
      const rightBound = Math.min(ownerWindow.innerWidth - 8,
        (paneRect?.right ?? ownerWindow.innerWidth) - 8);
      const width = Math.max(0, Math.min(250, rightBound - leftBound));
      const naturalLeft = determinedAlign === "right" ? rect.right - width : rect.left;
      const actualLeft = Math.min(Math.max(naturalLeft, leftBound), rightBound - width);
      style.left = `${actualLeft - rect.left}px`;
      style.right = "auto";
      style.width = `${width}px`;

      setActualAlign(determinedAlign);
      setPopoverStyle(style);
    }
    openRef.current = !isOpen;
    setIsOpen(!isOpen);
  };

  return (
    <div className="tempo-datepicker-wrapper" ref={containerRef}>
      {/* Trigger Button */}
      <button
        type="button"
        className={`tempo-datepicker-trigger ${isOpen ? "is-focused" : ""} ${value ? "has-value" : ""}`}
        onClick={handleToggle}
        title={t("selectDate", locale)}
      >
        <span className="tempo-datepicker-trigger-left">
          <CalendarIcon size={13} className="tempo-datepicker-icon" />
          <span className="tempo-datepicker-label">
            {value ? value : placeholder ?? t("selectDate", locale)}
          </span>
        </span>

        {!value && <span className="tempo-datepicker-empty-cue" />}
      </button>
      {value && (
        <button type="button" className="tempo-datepicker-clear-btn"
          onClick={() => onChange(undefined)}
          aria-label={t("clearDate", locale)} title={t("clearDate", locale)}>
          <CloseIcon size={12} />
        </button>
      )}

      {/* Floating Glass Popover */}
      {isOpen && (
        <div
          className={`tempo-datepicker-popover ${actualPlacement === "top" ? "is-top" : ""} ${
            actualAlign === "left" ? "is-align-left" : "is-align-right"
          }`}
          style={popoverStyle}
        >
          {/* Header */}
          <div className="tempo-datepicker-header">
            <button
              type="button"
              className="tempo-datepicker-nav-btn"
              onClick={handlePrevMonth}
              title={t("prevMonth", locale)}
            >
              <ChevronLeftIcon size={12} />
            </button>
            <span className="tempo-datepicker-month-title">{headerTitle}</span>
            <button
              type="button"
              className="tempo-datepicker-nav-btn"
              onClick={handleNextMonth}
              title={t("nextMonth", locale)}
            >
              <ChevronRightIcon size={12} />
            </button>
          </div>

          {/* Weekday Row */}
          <div className="tempo-datepicker-weekdays">
            {weekdays.map((w) => (
              <span key={w} className="tempo-datepicker-weekday">
                {w}
              </span>
            ))}
          </div>

          {/* Days Grid */}
          <div className="tempo-datepicker-grid">
            {calendarCells.map((cell, idx) => {
              if (!cell.isCurrentMonth) {
                return (
                  <span key={idx} className="tempo-datepicker-day is-dimmed">
                    {cell.day}
                  </span>
                );
              }
              return (
                <button
                  key={idx}
                  type="button"
                  className={`tempo-datepicker-day ${cell.isSelected ? "is-selected" : ""} ${
                    cell.isToday ? "is-today" : ""
                  }`}
                  onClick={() => {
                    onChange(cell.dateStr);
                    closePopover();
                  }}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>

          {/* Quick Action Footer */}
          <div className="tempo-datepicker-footer">
            <button
              type="button"
              className="tempo-datepicker-quick-btn"
              onClick={() => {
                onChange(todayStr);
                closePopover();
              }}
            >
              {t("today", locale)}
            </button>
            <button
              type="button"
              className="tempo-datepicker-quick-btn"
              onClick={() => {
                onChange(tomorrowStr);
                closePopover();
              }}
            >
              {t("tomorrow", locale)}
            </button>
            {value && (
              <button
                type="button"
                className="tempo-datepicker-quick-btn is-clear"
                onClick={() => {
                  onChange(undefined);
                  closePopover();
                }}
              >
                {t("clearDate", locale)}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
