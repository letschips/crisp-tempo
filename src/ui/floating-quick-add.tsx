import { h, render } from "preact";
import type { TempoStore } from "../core/store";
import { buildNewTask, type NewTaskInput } from "../core/new-task";
import { TaskCreateModal } from "./commands/TaskCreateModal";

const HOST_CLASS = "tempo-floating-host";

/**
 * Shows Tempo's new-task dialog over whatever page is open, without switching to the Tempo view.
 * Other plugins (Crisp Launchpad) call it through `openQuickAddModal()`. The store must be ready
 * and licensed; the caller checks both. Returns a function that closes the dialog.
 */
export function openFloatingQuickAdd(store: TempoStore, doc: Document = document): () => void {
  doc.querySelector(`.${HOST_CLASS}`)?.remove();
  // `tempo-root` carries Tempo's colour variables; the host class undoes its page layout.
  const host = doc.body.appendChild(doc.createElement("div"));
  host.className = `tempo-root ${HOST_CLASS}`;
  const restoreFocus = doc.activeElement as HTMLElement | null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    render(null, host);
    host.remove();
    if (restoreFocus?.isConnected) restoreFocus.focus?.();
  };
  const data = store.data!;
  const onAddTask = (params: NewTaskInput) => {
    const task = buildNewTask(params);
    store.updateDatabase((prev) => ({ ...prev, tasks: { ...prev.tasks, [task.id]: task } }));
  };
  render(
    h(TaskCreateModal, {
      isOpen: true,
      locale: data.locale,
      projects: data.database.projects,
      defaultDest: data.defaultDest === "today" ? "today" : "inbox",
      onClose: close,
      onAddTask,
    }),
    host,
  );
  return close;
}
