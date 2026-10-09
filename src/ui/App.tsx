import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Plugin, WorkspaceLeaf } from "obsidian";
import { Notice } from "obsidian";
import {
  buildChildrenMap,
  getAnytimeTasks,
  getCompletedTasks,
  getInboxTasks,
  getKpiStats,
  getCycleTimeStatus,
  getNavCounts,
  getSomedayTasks,
  getTodayTasks,
  getUpcomingTasks,
  getVisualOrderTasks,
  getWaitingTasks,
  sortByStatus,
} from "../core/selectors";
import { TempoStore } from "../core/store";
import type { Cycle, Project, Task, TaskPriority, TaskStatus, TodoDatabase } from "../core/types";
import { getTodayString } from "../services/date-service";
import { t, tf, type Locale } from "../services/i18n";
import { CycleModal } from "./commands/CycleModal";
import { MobileNavModal } from "./commands/MobileNavModal";
import { ProjectModal } from "./commands/ProjectModal";
import { SettingsModal } from "./commands/SettingsModal";
import { TaskCreateModal } from "./commands/TaskCreateModal";
import { GenericListView } from "./tasks/GenericListView";
import { Header } from "./layout/Header";
import { Inspector } from "./layout/Inspector";
import { KpiRow } from "./layout/KpiRow";
import { Sidebar } from "./layout/Sidebar";
import { TodayView } from "./today/TodayView";

interface AppProps {
  plugin: Plugin;
  leaf?: WorkspaceLeaf;
}

export function App({ plugin, leaf }: AppProps): JSX.Element {
  const store = TempoStore.get(plugin);
  const rootRef = useRef<HTMLDivElement>(null);

  // Crisp Tempo is a paid plugin: creating tasks, subtasks and projects needs a valid
  // license. Everything that touches existing data (view, edit, complete, delete, export)
  // stays available, so an expired license never holds the user's tasks hostage.
  const hasLicense = () => store.data?.licenseStatus === "valid";

  // Subscribe to central store. A single snapshot shape keeps the initial state and the
  // subscription callback from drifting apart.
  const snapshot = () => ({
    status: store.status,
    loadError: store.loadError,
    loadProblems: store.loadProblems,
    saveStatus: store.saveStatus,
    saveError: store.saveError,
    data: store.data,
  });

  const [storeState, setStoreState] = useState(snapshot);

  useEffect(() => {
    const unsubscribe = store.subscribe(() => {
      setStoreState(snapshot());
    });

    void store.load().catch(() => {});

    return () => {
      unsubscribe();
    };
  }, [store]);

  // Another plugin (Crisp Pulse) asked to show one of its tasks.
  useEffect(() => store.onRevealTask((taskId) => {
    if (store.data?.database.tasks[taskId]) setSelectedTaskId(taskId);
  }), [store]);

  // Listen for Quick Add command
  useEffect(() => {
    const unsubQuickAdd = store.onQuickAdd(() => {
      if (hasLicense()) setIsTaskCreateOpen(true);
      else promptForLicense();
    }, leaf);
    return unsubQuickAdd;
  }, [store, leaf]);

  // UI Navigation & View state. Nothing is selected on open: on a narrow pane the inspector
  // covers the whole view, so an automatic selection would hide the task list at launch.
  const [activeNav, setActiveNav] = useState<string>("today");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [isTaskCreateOpen, setIsTaskCreateOpen] = useState(false);
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [isCycleModalOpen, setIsCycleModalOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [moveMessage, setMoveMessage] = useState<string | null>(null);
  const [confirmSalvage, setConfirmSalvage] = useState(false);
  const [licensePrompt, setLicensePrompt] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingCycleId, setEditingCycleId] = useState<string | null>(null);

  /** Explains why creation is locked and opens the activation form. */
  function promptForLicense(): void {
    new Notice(t("licenseRequiredNotice", store.data?.locale ?? "zh"));
    setLicensePrompt(true);
    setIsSettingsOpen(true);
  }
  const openQuickAdd = () => {
    if (hasLicense()) setIsTaskCreateOpen(true);
    else promptForLicense();
  };
  const openNewProject = () => {
    if (hasLicense()) setIsProjectModalOpen(true);
    else promptForLicense();
  };
  const [isRecovering, setIsRecovering] = useState(false);

  // Moving to another view drops the previous selection. Without this the inspector keeps
  // showing a task that is no longer part of the list on screen, and arrow keys start from
  // an index that does not exist in the new list.
  const prevNavRef = useRef(activeNav);
  useEffect(() => {
    if (prevNavRef.current !== activeNav) {
      prevNavRef.current = activeNav;
      setSelectedTaskId(null);
      setMoveMessage(null);
      setConfirmSalvage(false);
    }
  }, [activeNav]);

  // Scroll root to top on mobile when opening inspector
  useEffect(() => {
    if (selectedTaskId && rootRef.current) {
      rootRef.current.scrollTop = 0;
    }
  }, [selectedTaskId]);

  // Refresh at the next local midnight and when the window resumes.
  const [today, setToday] = useState(() => getTodayString());
  useEffect(() => {
    const doc = rootRef.current?.ownerDocument ?? document;
    const ownerWindow = doc.defaultView ?? window;
    let timer: ReturnType<typeof setTimeout>;
    const checkDate = () => {
      const fresh = getTodayString();
      setToday((prev) => (prev === fresh ? prev : fresh));
    };
    const schedule = () => {
      const now = new Date();
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = setTimeout(() => {
        checkDate();
        schedule();
      }, Math.max(1000, nextMidnight.getTime() - now.getTime() + 50));
    };
    const onResume = () => {
      checkDate();
      clearTimeout(timer);
      schedule();
    };
    schedule();
    ownerWindow.addEventListener("focus", onResume);
    doc.addEventListener("visibilitychange", onResume);
    return () => {
      clearTimeout(timer);
      ownerWindow.removeEventListener("focus", onResume);
      doc.removeEventListener("visibilitychange", onResume);
    };
  }, []);

  // A save normally lands within the 300 ms debounce. Showing the "saving" strip for every
  // edit inserted and removed a row above the KPI cards, so the whole board jumped on each
  // click. The strip now appears only when a save is genuinely slow; errors show at once.
  const [slowSave, setSlowSave] = useState(false);
  useEffect(() => {
    if (storeState.saveStatus !== "saving") {
      setSlowSave(false);
      return;
    }
    const timer = setTimeout(() => setSlowSave(true), 1500);
    return () => clearTimeout(timer);
  }, [storeState.saveStatus]);

  // Derived view state. Memoised on the database and the navigation target, so switching
  // views does not rescan the task set and the keydown effect below only re-subscribes when
  // the visible list actually changes.
  const database = storeState.data?.database ?? null;
  const derived = useMemo(() => {
    if (!database) return null;
    const allTasks = database.tasks;
    const taskList = Object.values(allTasks);
    let visibleTasks: Task[] = [];

    if (activeNav === "today") visibleTasks = getTodayTasks(allTasks, today);
    else if (activeNav === "inbox") visibleTasks = getInboxTasks(allTasks);
    else if (activeNav === "upcoming") visibleTasks = getUpcomingTasks(allTasks, today);
    else if (activeNav === "anytime") visibleTasks = getAnytimeTasks(allTasks, today);
    else if (activeNav === "someday") visibleTasks = getSomedayTasks(allTasks);
    else if (activeNav === "waiting") visibleTasks = getWaitingTasks(allTasks);
    else if (activeNav === "completed") visibleTasks = getCompletedTasks(allTasks);
    else if (activeNav.startsWith("proj:")) {
      const projectId = activeNav.slice(5);
      visibleTasks = sortByStatus(taskList.filter((t) => !t.parentTaskId && t.projectId === projectId));
    } else if (activeNav.startsWith("cycle:")) {
      const cycleId = activeNav.slice(6);
      visibleTasks = sortByStatus(taskList.filter((t) => !t.parentTaskId && t.cycleId === cycleId));
    }

    return {
      taskList,
      visibleTasks,
      childrenMap: buildChildrenMap(allTasks),
      counts: getNavCounts(allTasks, today),
      kpi: getKpiStats(allTasks, today),
    };
  }, [database, activeNav, today]);

  // Keyboard shortcuts. The window listener is a single fixed hook installed before the
  // loading/error early returns, so the hook order never changes between renders; each ready
  // render swaps in a handler that sees the current state, and the other states disarm it.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = () => {};
  useEffect(() => {
    const ownerWindow = rootRef.current?.ownerDocument?.defaultView;
    if (!ownerWindow) return;
    const listener = (e: KeyboardEvent) => keyHandlerRef.current(e);
    ownerWindow.addEventListener("keydown", listener);
    return () => ownerWindow.removeEventListener("keydown", listener);
  }, []);

  const selectedTaskSubtasks = useMemo(
    () => (selectedTaskId ? derived?.childrenMap.get(selectedTaskId) ?? [] : []),
    [derived, selectedTaskId],
  );

  // Error guard. Nothing is written from this state: the user gets the reason, a list of
  // rejected entries, and three ways forward that all preserve the original file.
  if (storeState.status === "error") {
    const errorLocale: Locale = storeState.data?.locale ?? store.loadLocale ?? "zh";
    const problems = storeState.loadProblems;

    const handleExport = async () => {
      try {
        const path = await store.exportRawData();
        new Notice(tf("exportDone", errorLocale, { path }));
      } catch (err) {
        new Notice(tf("exportFailed", errorLocale, { detail: String(err) }));
      }
    };

    const handleSalvage = async () => {
      setIsRecovering(true);
      try {
        await store.loadDroppingInvalidEntries();
        setConfirmSalvage(false);
      } catch (err) {
        console.error("Crisp Tempo: recovery failed", err);
      } finally {
        setIsRecovering(false);
      }
    };

    return (
      <div className="tempo-root" ref={rootRef}>
        <div className="tempo-error-card">
          <h3 className="tempo-error-title">{t("loadErrorTitle", errorLocale)}</h3>
          <p className="tempo-error-desc">{t("loadErrorDesc", errorLocale)}</p>
          {storeState.loadError && <p className="tempo-error-detail">{storeState.loadError}</p>}

          {problems.length > 0 && (
            <div className="tempo-error-problems">
              <div className="tempo-error-problems-title">
                {tf("loadProblemsTitle", errorLocale, { n: problems.length })}
              </div>
              <ul className="tempo-error-problems-list">
                {problems.slice(0, 8).map((problem) => (
                  <li key={problem.entry}>
                    <code>{problem.entry}</code>
                    <span>{problem.reason}</span>
                  </li>
                ))}
                {problems.length > 8 && <li className="tempo-error-more">…</li>}
              </ul>
              <p className="tempo-error-hint">{t("salvageHint", errorLocale)}</p>
            </div>
          )}

          <div className="tempo-error-actions">
            <button
              type="button"
              className="tempo-btn-primary"
              onClick={() => void store.load(true).catch(() => {})}
            >
              {t("retryLoad", errorLocale)}
            </button>
            <button type="button" className="tempo-action-btn" onClick={() => void handleExport()}>
              {t("exportRawData", errorLocale)}
            </button>
            {problems.length > 0 &&
              (confirmSalvage ? (
                <button
                  type="button"
                  className="tempo-action-btn is-danger"
                  disabled={isRecovering}
                  onClick={() => void handleSalvage()}
                >
                  {t("salvageConfirm", errorLocale)}
                </button>
              ) : (
                <button
                  type="button"
                  className="tempo-action-btn is-danger"
                  onClick={() => setConfirmSalvage(true)}
                >
                  {tf("salvageAction", errorLocale, { n: problems.length })}
                </button>
              ))}
          </div>
        </div>
      </div>
    );
  }

  // Loading guard: no writes and no stale UI until the database is ready.
  if (storeState.status === "loading" || !storeState.data || !derived) {
    const loadingLocale: Locale = storeState.data?.locale ?? store.loadLocale ?? "zh";
    return (
      <div className="tempo-root" ref={rootRef}>
        <div className="tempo-loading-container">
          <div className="tempo-spinner" />
          <span className="tempo-loading-text">{t("loading", loadingLocale)}</span>
        </div>
      </div>
    );
  }

  const { database: db, locale, defaultDest = "inbox" } = storeState.data;
  const allTasks = db.tasks;
  const { taskList, visibleTasks, childrenMap, counts, kpi } = derived;
  const selectedTask = selectedTaskId ? allTasks[selectedTaskId] ?? null : null;

  // Toggle complete / active status. A finished or canceled task reopens as todo; clicking
  // a canceled task's checkbox used to mark it done, which it never was.
  const handleToggleStatus = (taskId: string) => {
    store.updateDatabase((prev) => {
      const t = prev.tasks[taskId];
      if (!t) return prev;
      const reopen = t.status === "done" || t.status === "canceled";
      const nextStatus: TaskStatus = reopen ? "todo" : "done";
      return {
        ...prev,
        tasks: {
          ...prev.tasks,
          [taskId]: {
            ...t,
            status: nextStatus,
            completedAt: reopen ? undefined : Date.now(),
            canceledAt: undefined,
            updatedAt: Date.now(),
          },
        },
      };
    });
  };

  // Update task attributes
  const handleUpdateTask = (updates: Partial<Task>) => {
    if (!selectedTaskId) return;
    store.updateDatabase((prev) => {
      const t = prev.tasks[selectedTaskId];
      if (!t) return prev;
      return {
        ...prev,
        tasks: {
          ...prev.tasks,
          [selectedTaskId]: {
            ...t,
            ...updates,
            updatedAt: Date.now(),
          },
        },
      };
    });
  };

  // Delete task and its subtasks
  const handleDeleteTask = (taskId: string) => {
    const isSelected = taskId === selectedTaskId;
    store.updateDatabase((prev) => {
      const nextTasks = { ...prev.tasks };
      delete nextTasks[taskId];
      for (const [id, t] of Object.entries(nextTasks)) {
        if (t.parentTaskId === taskId) {
          delete nextTasks[id];
        }
      }
      return {
        ...prev,
        tasks: nextTasks,
      };
    });
    if (isSelected) setSelectedTaskId(null);
  };

  // Add task from TaskCreateModal
  const handleAddTask = (params: {
    title: string;
    description?: string;
    triage: "inbox" | "processed";
    availability?: "anytime" | "someday";
    priority?: TaskPriority;
    focusDate?: string;
    dueDate?: string;
    projectId?: string;
    cycleId?: string;
  }) => {
    if (!hasLicense()) {
      promptForLicense();
      return;
    }
    const newId = `task-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const newTask: Task = {
      id: newId,
      title: params.title,
      description: params.description,
      status: "todo",
      triage: params.triage,
      availability: params.availability || "anytime",
      priority: params.priority || "none",
      projectId: params.projectId,
      cycleId: params.cycleId,
      focusDate: params.focusDate,
      dueDate: params.dueDate,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      order: `z${Date.now()}`,
    };

    store.updateDatabase((prev) => ({
      ...prev,
      tasks: {
        ...prev.tasks,
        [newId]: newTask,
      },
    }));

    setSelectedTaskId(newId);
  };

  // Add subtask explicitly under parent task ID
  const handleAddSubtask = (title: string, explicitParentId?: string) => {
    const parentId = explicitParentId || selectedTaskId;
    if (!parentId) return;
    if (!hasLicense()) {
      promptForLicense();
      return;
    }

    const subId = `task-sub-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const newSubtask: Task = {
      id: subId,
      title,
      status: "todo",
      triage: "processed",
      availability: "anytime",
      priority: "none",
      parentTaskId: parentId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      order: `z${Date.now()}`,
    };

    store.updateDatabase((prev) => ({
      ...prev,
      tasks: {
        ...prev.tasks,
        [subId]: newSubtask,
      },
    }));
  };

  // Create Project
  const handleCreateProject = (params: {
    title: string;
    color: string;
    description?: string;
  }) => {
    if (!hasLicense()) {
      promptForLicense();
      return;
    }
    const newProjId = `proj-${Date.now()}`;
    const newProj: Project = {
      id: newProjId,
      title: params.title,
      color: params.color,
      description: params.description,
      status: "active",
      priority: "medium",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      order: `z${Date.now()}`,
    };

    store.updateDatabase((prev) => ({
      ...prev,
      projects: {
        ...prev.projects,
        [newProjId]: newProj,
      },
    }));

    setActiveNav(`proj:${newProjId}`);
  };

  // Create Cycle (ensuring single active 'current' cycle)
  const handleCreateCycle = (params: {
    title: string;
    startDate: string;
    endDate: string;
    status: "current" | "upcoming";
  }) => {
    const newCycleId = `cycle-${Date.now()}`;
    const newCycle: Cycle = {
      id: newCycleId,
      title: params.title,
      startDate: params.startDate,
      endDate: params.endDate,
      status: params.status,
    };

    store.updateDatabase((prev) => {
      const nextCycles = { ...prev.cycles };
      if (params.status === "current") {
        for (const [id, c] of Object.entries(nextCycles)) {
          if (c.status === "current") {
            nextCycles[id] = { ...c, status: "previous" };
          }
        }
      }
      nextCycles[newCycleId] = newCycle;
      return {
        ...prev,
        cycles: nextCycles,
      };
    });

    setActiveNav(`cycle:${newCycleId}`);
  };

  // Editing and deleting existing projects and cycles is not gated: it only changes data
  // the user already has. Deleting keeps the tasks and just unlinks them; ⌘Z restores both.
  const handleUpdateProject = (
    projectId: string,
    params: { title: string; color: string; description?: string },
  ) => {
    store.updateDatabase((prev) => {
      const project = prev.projects[projectId];
      if (!project) return prev;
      return {
        ...prev,
        projects: {
          ...prev.projects,
          [projectId]: { ...project, ...params, updatedAt: Date.now() },
        },
      };
    });
  };

  const handleDeleteProject = (projectId: string) => {
    const project = store.data?.database.projects[projectId];
    if (!project) return;
    store.updateDatabase((prev) => {
      const nextProjects = { ...prev.projects };
      delete nextProjects[projectId];
      const nextTasks = { ...prev.tasks };
      for (const [id, task] of Object.entries(nextTasks)) {
        if (task.projectId === projectId) {
          nextTasks[id] = { ...task, projectId: undefined, updatedAt: Date.now() };
        }
      }
      return { ...prev, projects: nextProjects, tasks: nextTasks };
    });
    if (activeNav === `proj:${projectId}`) setActiveNav("today");
    new Notice(tf("projectDeleted", locale, { title: project.title }));
  };

  const handleUpdateCycle = (
    cycleId: string,
    params: { title: string; startDate: string; endDate: string; status: "current" | "upcoming" },
  ) => {
    store.updateDatabase((prev) => {
      const cycle = prev.cycles[cycleId];
      if (!cycle) return prev;
      return { ...prev, cycles: { ...prev.cycles, [cycleId]: { ...cycle, ...params } } };
    });
  };

  const handleDeleteCycle = (cycleId: string) => {
    const cycle = store.data?.database.cycles[cycleId];
    if (!cycle) return;
    store.updateDatabase((prev) => {
      const nextCycles = { ...prev.cycles };
      delete nextCycles[cycleId];
      const nextTasks = { ...prev.tasks };
      for (const [id, task] of Object.entries(nextTasks)) {
        if (task.cycleId === cycleId) {
          nextTasks[id] = { ...task, cycleId: undefined, updatedAt: Date.now() };
        }
      }
      return { ...prev, cycles: nextCycles, tasks: nextTasks };
    });
    if (activeNav === `cycle:${cycleId}`) setActiveNav("today");
    new Notice(tf("cycleDeleted", locale, { title: cycle.title }));
  };

  // Reset data to initial mock (safe with undo snapshot)
  const handleResetData = async (): Promise<boolean> => {
    store.resetToEmpty();
    await store.flush();
    return store.saveStatus === "saved";
  };

  // Change locale
  const handleChangeLocale = (newLocale: Locale) => {
    store.setLocale(newLocale);
  };

  // Change default destination
  const handleChangeDefaultDest = (newDest: "inbox" | "today") => {
    store.setDefaultDest(newDest);
  };

  // Undo (⌘Z or button)
  const handleUndo = () => {
    store.undo();
  };

  // Moving between buckets changes scheduling without discarding the due date.
  const handleMoveTaskToBucket = (taskId: string, bucket: string) => {
    const task = store.data?.database.tasks[taskId];
    if (!task) return;
    const knownBucket = ["inbox", "today", "upcoming", "anytime", "someday", "waiting", "completed"].includes(bucket);
    if (!knownBucket && !bucket.startsWith("proj:") && !bucket.startsWith("cycle:")) return;
    if (bucket === "upcoming" && !(task.startDate && task.startDate > today) &&
        !(task.dueDate && task.dueDate > today)) {
      setMoveMessage(t("moveToUpcomingNeedsDate", locale));
      return;
    }
    setMoveMessage(null);
    store.updateDatabase((prev) => {
      const current = prev.tasks[taskId];
      if (!current) return prev;
      let updatedTask: Task = { ...current, updatedAt: Date.now() };
      if (bucket.startsWith("proj:")) {
        const projectId = bucket.slice(5);
        if (!prev.projects[projectId]) return prev;
        updatedTask.projectId = projectId;
      } else if (bucket.startsWith("cycle:")) {
        const cycleId = bucket.slice(6);
        if (!prev.cycles[cycleId]) return prev;
        updatedTask.cycleId = cycleId;
      } else {
        if (current.status === "done" || current.status === "canceled") {
          updatedTask = { ...updatedTask, status: "todo", completedAt: undefined, canceledAt: undefined };
        }
        if (bucket === "inbox") {
          updatedTask = { ...updatedTask, triage: "inbox", focusDate: undefined };
        } else if (bucket === "today") {
          updatedTask = { ...updatedTask, triage: "processed", focusDate: today, availability: "anytime" };
        } else if (bucket === "upcoming") {
          updatedTask = {
            ...updatedTask, triage: "processed", availability: "anytime", focusDate: undefined,
            startDate: current.startDate && current.startDate > today ? current.startDate : undefined,
          };
        } else if (bucket === "anytime") {
          updatedTask = {
            ...updatedTask, triage: "processed", availability: "anytime",
            focusDate: undefined, startDate: undefined,
          };
        } else if (bucket === "someday") {
          updatedTask = { ...updatedTask, triage: "processed", availability: "someday", focusDate: undefined };
        } else if (bucket === "waiting") {
          updatedTask = {
            ...updatedTask, triage: "processed", status: "waiting", focusDate: undefined,
            completedAt: undefined, canceledAt: undefined,
          };
        } else if (bucket === "completed") {
          updatedTask = {
            ...updatedTask, triage: "processed", availability: "anytime", status: "done",
            completedAt: Date.now(), canceledAt: undefined,
          };
        }
      }
      return { ...prev, tasks: { ...prev.tasks, [taskId]: updatedTask } };
    });
  };

  const handleMoveTaskToProject = (taskId: string, projectId: string) => {
    store.updateDatabase((prev) => {
      const task = prev.tasks[taskId];
      if (!task) return prev;
      return {
        ...prev,
        tasks: {
          ...prev.tasks,
          [taskId]: {
            ...task,
            projectId,
            updatedAt: Date.now(),
          },
        },
      };
    });
  };

  // Keyboard navigation & quick add, with a strict scope guard.
  keyHandlerRef.current = (e: KeyboardEvent) => {
    const rootEl = rootRef.current;
    const ownerDocument = rootEl?.ownerDocument;
    if (!rootEl || !ownerDocument) return;
    if (e.defaultPrevented || e.isComposing) return;
    // Modals own the keyboard while open.
    if (
      isTaskCreateOpen ||
      isProjectModalOpen ||
      isCycleModalOpen ||
      isSettingsOpen ||
      isMobileNavOpen ||
      editingProjectId ||
      editingCycleId
    ) {
      return;
    }

    // 2. Check active element
    const activeEl = ownerDocument.activeElement;
    const isInput =
      ["INPUT", "TEXTAREA", "SELECT"].includes(activeEl?.tagName ?? "") ||
      activeEl?.getAttribute("contenteditable") === "true";

    // 3. Container and focus containment check
    // Only the active Tempo leaf receives shortcuts, including in popout windows.
    if (leaf && plugin.app.workspace.activeLeaf !== leaf) return;
    if (!rootEl.isConnected || rootEl.getClientRects().length === 0 ||
        rootEl.offsetWidth === 0 || rootEl.offsetHeight === 0) return;

    // Focus in another pane belongs to that pane.
    if (activeEl && activeEl !== ownerDocument.body && !rootEl.contains(activeEl)) {
      return;
    }

    // Quick Add (Cmd+Shift+Space or 'c' when not typing in any input)
    if (
      (e.metaKey && e.shiftKey && e.code === "Space") ||
      (!isInput && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === "c")
    ) {
      e.preventDefault();
      openQuickAdd();
      return;
    }

    // Undo (Cmd+Z or Ctrl+Z)
    if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey && !isInput) {
      e.preventDefault();
      handleUndo();
      return;
    }

    // If typing in input / select, do not intercept remaining keys
    if (isInput) return;

    // Esc: deselect
    if (e.key === "Escape") {
      if (selectedTaskId) {
        e.preventDefault();
        setSelectedTaskId(null);
      }
      return;
    }

    // Arrow navigation: ordered strictly according to on-screen visual presentation!
    if (!e.metaKey && !e.ctrlKey && !e.altKey &&
        (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const ordered = getVisualOrderTasks(visibleTasks, activeNav);
      if (ordered.length === 0) return;

      const currentIndex = ordered.findIndex((t) => t.id === selectedTaskId);
      if (e.key === "ArrowDown") {
        const nextIndex = currentIndex < ordered.length - 1 ? currentIndex + 1 : 0;
        if (ordered[nextIndex]) setSelectedTaskId(ordered[nextIndex].id);
      } else {
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : ordered.length - 1;
        if (ordered[prevIndex]) setSelectedTaskId(ordered[prevIndex].id);
      }
      return;
    }

    // 'x' toggles complete on selected task
    if (e.key === "x" && selectedTaskId &&
        !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      handleToggleStatus(selectedTaskId);
      return;
    }
  };

  return (
    <div className={`tempo-root ${selectedTask ? "has-selected-task" : ""}`} ref={rootRef}>
      <div className="tempo-wrapper">
        {/* 1. Crisp Suite Header */}
        <Header
          locale={locale}
          activeNav={activeNav}
          tasks={db.tasks}
          counts={counts}
          projects={db.projects}
          cycles={db.cycles}
          onSelectNav={(nav) => setActiveNav(nav)}
          onOpenSettings={() => setIsSettingsOpen(true)}
          isLicensed={storeState.data.licenseStatus === "valid"}
          onOpenLicense={() => {
            setLicensePrompt(true);
            setIsSettingsOpen(true);
          }}
          onUndo={handleUndo}
          onOpenQuickAdd={openQuickAdd}
          onOpenProjects={() => setIsMobileNavOpen(true)}
          onMoveTaskToBucket={handleMoveTaskToBucket}
        />

        {((storeState.saveStatus === "saving" && slowSave) || storeState.saveStatus === "error") && (
          <div
            className={`tempo-save-feedback ${storeState.saveStatus === "error" ? "is-error" : ""}`}
            role={storeState.saveStatus === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            <span>{storeState.saveStatus === "error" ? t("saveFailed", locale) : t("saving", locale)}</span>
            {storeState.saveStatus === "error" && (
              <button type="button" className="tempo-action-btn" onClick={() => void store.flush()}>
                {t("retrySave", locale)}
              </button>
            )}
          </div>
        )}

        {moveMessage && (
          <div className="tempo-save-feedback is-error" role="alert">
            <span>{moveMessage}</span>
            <button type="button" className="tempo-action-btn" onClick={() => setMoveMessage(null)}>
              {t("close", locale)}
            </button>
          </div>
        )}

        {/* 2. Crisp Pulse Style KPI Row */}
        <KpiRow
          stats={kpi}
          locale={locale}
          activeNav={activeNav}
          onSelectNav={(nav) => setActiveNav(nav)}
        />

        {/* 3. Workbench (Cards Layout) */}
        <div className="tempo-workbench">
          {/* Left Sidebar Card (Desktop) */}
          <Sidebar
            locale={locale}
            activeNav={activeNav}
            onSelectNav={(nav) => setActiveNav(nav)}
            tasks={db.tasks}
            counts={counts}
            projects={db.projects}
            cycles={db.cycles}
            onOpenQuickAdd={openQuickAdd}
            onOpenNewProject={openNewProject}
            onEditProject={(id) => setEditingProjectId(id)}
            onEditCycle={(id) => setEditingCycleId(id)}
            onOpenNewCycle={() => setIsCycleModalOpen(true)}
            today={today}
            onMoveTaskToBucket={handleMoveTaskToBucket}
            onMoveTaskToProject={handleMoveTaskToProject}
          />

          {/* Center Main Card */}
          {activeNav === "today" ? (
            <TodayView
              today={today}
              tasks={visibleTasks}
              locale={locale}
              childrenMap={childrenMap}
              projects={db.projects}
              selectedTaskId={selectedTaskId}
              onSelectTask={(id) => setSelectedTaskId(id)}
              onToggleStatus={handleToggleStatus}
              onOpenQuickAdd={openQuickAdd}
            />
          ) : (
            <GenericListView
              title={
                activeNav.startsWith("proj:")
                  ? db.projects[activeNav.replace("proj:", "")]?.title || t("project", locale)
                  : activeNav.startsWith("cycle:")
                  ? db.cycles[activeNav.replace("cycle:", "")]?.title || t("cycles", locale)
                  : t(activeNav as any, locale) || activeNav.toUpperCase()
              }
              subtitle={
                activeNav === "inbox"
                  ? t("inboxSubtitle", locale)
                  : activeNav === "upcoming"
                  ? t("upcomingSubtitle", locale)
                  : activeNav === "anytime"
                  ? t("anytimeSubtitle", locale)
                  : activeNav === "someday"
                  ? t("somedaySubtitle", locale)
                  : activeNav === "waiting"
                  ? t("waitingSubtitle", locale)
                  : activeNav === "completed"
                  ? t("completedLog", locale)
                  : activeNav.startsWith("proj:")
                  ? db.projects[activeNav.replace("proj:", "")]?.description || ""
                  : activeNav.startsWith("cycle:")
                  ? `${db.cycles[activeNav.replace("cycle:", "")]?.startDate || ""} ~ ${
                      db.cycles[activeNav.replace("cycle:", "")]?.endDate || ""
                    }`
                  : ""
              }
              locale={locale}
              tasks={visibleTasks}
              childrenMap={childrenMap}
              projects={db.projects}
              project={
                activeNav.startsWith("proj:")
                  ? db.projects[activeNav.replace("proj:", "")]
                  : undefined
              }
              selectedTaskId={selectedTaskId}
              onSelectTask={(id) => setSelectedTaskId(id)}
              onToggleStatus={handleToggleStatus}
              onOpenQuickAdd={openQuickAdd}
              onBackToToday={() => setActiveNav("today")}
              onEdit={
                activeNav.startsWith("proj:") && db.projects[activeNav.slice(5)]
                  ? () => setEditingProjectId(activeNav.slice(5))
                  : activeNav.startsWith("cycle:") && db.cycles[activeNav.slice(6)]
                  ? () => setEditingCycleId(activeNav.slice(6))
                  : undefined
              }
            />
          )}

          {/* Right Inspector Card (Responsive) */}
          {selectedTask && (
            <Inspector
              task={selectedTask}
              locale={locale}
              projects={db.projects}
              cycles={db.cycles}
              subtasks={selectedTaskSubtasks}
              onClose={() => setSelectedTaskId(null)}
              onUpdateTask={handleUpdateTask}
              onDeleteTask={() => handleDeleteTask(selectedTask.id)}
              onAddSubtask={handleAddSubtask}
              onToggleSubtask={handleToggleStatus}
              onDeleteSubtask={handleDeleteTask}
              canAddSubtask={storeState.data.licenseStatus === "valid"}
              onRequestLicense={promptForLicense}
              onOpenSource={(notePath) => void plugin.app.workspace.openLinkText(notePath, "", false)}
            />
          )}
        </div>

        {/* 4. Independent Floating Modals - Unmounted on close to cleanly reset drafts */}
        {isTaskCreateOpen && (
          <TaskCreateModal
            isOpen={true}
            locale={locale}
            projects={db.projects}
            defaultDest={defaultDest}
            defaultProjectId={activeNav.startsWith("proj:") ? activeNav.replace("proj:", "") : undefined}
            defaultCycleId={activeNav.startsWith("cycle:") ? activeNav.replace("cycle:", "") : undefined}
            onClose={() => setIsTaskCreateOpen(false)}
            onAddTask={handleAddTask}
          />
        )}

        {isProjectModalOpen && (
          <ProjectModal
            isOpen={true}
            locale={locale}
            onClose={() => setIsProjectModalOpen(false)}
            onCreateProject={handleCreateProject}
          />
        )}

        {editingProjectId && db.projects[editingProjectId] && (
          <ProjectModal
            key={`edit-${editingProjectId}`}
            isOpen={true}
            locale={locale}
            initial={db.projects[editingProjectId]}
            linkedTaskCount={taskList.filter((task) => task.projectId === editingProjectId).length}
            onClose={() => setEditingProjectId(null)}
            onCreateProject={(params) => handleUpdateProject(editingProjectId, params)}
            onDeleteProject={() => handleDeleteProject(editingProjectId)}
          />
        )}

        {editingCycleId && db.cycles[editingCycleId] && (
          <CycleModal
            key={`edit-${editingCycleId}`}
            isOpen={true}
            locale={locale}
            initial={db.cycles[editingCycleId]}
            linkedTaskCount={taskList.filter((task) => task.cycleId === editingCycleId).length}
            onClose={() => setEditingCycleId(null)}
            onCreateCycle={(params) => handleUpdateCycle(editingCycleId, params)}
            onDeleteCycle={() => handleDeleteCycle(editingCycleId)}
          />
        )}

        {isCycleModalOpen && (
          <CycleModal
            isOpen={true}
            locale={locale}
            nextCycleNumber={Object.keys(db.cycles).length + 1}
            currentCycleEnd={Object.values(db.cycles)
              .filter((cycle) => getCycleTimeStatus(cycle, today) !== "previous")
              .reduce((latest, cycle) => cycle.endDate > latest ? cycle.endDate : latest, "")}
            onClose={() => setIsCycleModalOpen(false)}
            onCreateCycle={handleCreateCycle}
          />
        )}

        {isSettingsOpen && (
          <SettingsModal
            isOpen={true}
            locale={locale}
            version={plugin?.manifest?.version || "0.1.0"}
            defaultDest={defaultDest}
            taskCount={taskList.length}
            projectCount={Object.keys(db.projects).length}
            cycleCount={Object.keys(db.cycles).length}
            licenseRequired={licensePrompt}
            onClose={() => {
              setIsSettingsOpen(false);
              setLicensePrompt(false);
            }}
            onChangeLocale={handleChangeLocale}
            onChangeDefaultDest={handleChangeDefaultDest}
            onChangeExportFolder={(folder) => store.setExportFolder(folder)}
            onResetData={handleResetData}
            onExportData={(folder) => store.exportRawData(folder)}
            exportFolder={storeState.data?.exportFolder}
            licenseKey={storeState.data?.licenseKey}
            licenseStatus={storeState.data?.licenseStatus}
            licensePayload={storeState.data?.licensePayload}
            onActivateLicense={(key) => store.activateLicense(key)}
            onClearLicense={() => store.clearLicense()}
          />
        )}

        {isMobileNavOpen && (
          <MobileNavModal
            isOpen={true}
            locale={locale}
            activeNav={activeNav}
            projects={db.projects}
            cycles={db.cycles}
            tasks={db.tasks}
            onClose={() => setIsMobileNavOpen(false)}
            onSelectNav={(nav) => {
              setActiveNav(nav);
              setIsMobileNavOpen(false);
            }}
            onOpenNewProject={() => {
              setIsMobileNavOpen(false);
              openNewProject();
            }}
            onOpenNewCycle={() => {
              setIsMobileNavOpen(false);
              setIsCycleModalOpen(true);
            }}
          />
        )}
      </div>
    </div>
  );
}
