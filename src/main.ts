import { Plugin, PluginSettingTab, Setting, Notice, addIcon, type App, type WorkspaceLeaf } from "obsidian";
import { TempoStore } from "./core/store";
import { TempoView, TEMPO_VIEW_TYPE } from "./views/TempoView";
import { t, tf } from "./services/i18n";
import { getTodayString } from "./services/date-service";
import {
  findSourceTask,
  toSourceSnapshot,
  upsertSourceTask,
  type SourceTaskInput,
  type SourceTaskSnapshot,
} from "./services/source-tasks";

const TEMPO_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><g fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"><path d="M10.543 9.513a5.1 5.1 0 0 1 1.71-.89a4.5 4.5 0 0 1 1.931-.19a.32.32 0 0 0 .39-.26a.33.33 0 0 0-.27-.4a5.55 5.55 0 0 0-2.26 0a6.4 6.4 0 0 0-2.131.84a2.17 2.17 0 0 0-1.11 1.39a1.56 1.56 0 0 0 .47 1.3a2.5 2.5 0 0 0 1.74.831a5.9 5.9 0 0 0 1.91-.28a3.9 3.9 0 0 1 1.481-.21c.82.13 1.69.64 2.55.81a2.5 2.5 0 0 0 1.351-.06a.38.38 0 1 0-.22-.73a1.9 1.9 0 0 1-.94 0c-.86-.24-1.71-.84-2.53-1a4.7 4.7 0 0 0-2.002.07a5.5 5.5 0 0 1-1.54.2a1.35 1.35 0 0 1-.9-.42c-.12-.13-.2-.21-.16-.31a1.3 1.3 0 0 1 .53-.69"/><path d="M22.217 8.163c-1.07-.45-2.001-1-3.051-1.51a12.7 12.7 0 0 0-2.161-.861a8.7 8.7 0 0 0-3.851-.18q.275-1.04.38-2.11a6.8 6.8 0 0 0-.08-1.871C13.204.44 12.564 0 12.004 0a2.27 2.27 0 0 0-1.791 1.19l-.71 1.25a29 29 0 0 0-1.271 3.412h-.12a8.3 8.3 0 0 0-2.22 2.15a8 8 0 0 0-.811 1.301a7.6 7.6 0 0 0-.55 1.46a2.84 2.84 0 0 0 .33 2.241a1.26 1.26 0 0 0 1.75.26a18 18 0 0 0-.5 3.742q.013.233.07.46q.048.241.14.47q.226.53.56 1c.13.31.83.49 2.071-.66q.195-.18.36-.39q.168-.209.3-.44q.26-.535.46-1.09c.367.316.787.563 1.241.73q.402.15.83.18c.434.03.87-.01 1.29-.12c.09 0 .16-.11.25-.15a4.8 4.8 0 0 0 2.412.76a8.3 8.3 0 0 0 1.77-.21a18.5 18.5 0 0 1 2.441-.48a.38.38 0 0 0 0-.76c-1-.074-2.005-.05-3 .07l-1.131.11h-.72c-.337 0-.673-.037-1-.11a1.7 1.7 0 0 0 .29-.41a1.28 1.28 0 0 0-.471-1.621h-.14a2 2 0 0 0 .87-1.34a1.24 1.24 0 0 0-.63-1.281a.38.38 0 0 0-.45.61a.44.44 0 0 1 .12.48a1 1 0 0 1-.71.56a2 2 0 0 1-.74 0l-.6-.06a8 8 0 0 1-.871-.18v-.55a.34.34 0 1 0-.64-.2c-.1.18-.74 1.44-.79 1.6a4 4 0 0 0-.11.52a2 2 0 0 0 0 .22c-.26-.11-.48-.24-.74-.34a1.4 1.4 0 0 0-.34-.11a2 2 0 0 0-.341-.05c-.31 0-.57.06-.87.08h-.06c.54-2.11 1.09-4.31 1.72-6.471A34.6 34.6 0 0 1 10.642 3l.561-1.15c.23-.39.47-.7.75-.71s.37.27.49.74a5.6 5.6 0 0 1 .16 1.6q-.05 1.277-.34 2.521a.39.39 0 0 0 .28.46a.37.37 0 0 0 .4-.2a.2.2 0 0 0 .13 0c.91.002 1.815.144 2.682.42c.32.1.64.22.95.33c.49.17 1 .36 1.45.54c1.24.47 2.491.95 3.812 1.311a.39.39 0 0 0 .49-.24a.37.37 0 0 0-.24-.46M6.642 12.004a1.2 1.2 0 0 1-.45.34a.5.5 0 0 1-.35 0c-.08 0-.08-.13-.11-.22a1.85 1.85 0 0 1 0-1.09a10 10 0 0 1 .56-1.5q.329-.752.76-1.451q.36-.527.79-1c0 .18-.11.34-.16.52a59 59 0 0 0-.82 4c-.05.14-.12.271-.22.401m5.361 2.6c.52.15 1.071.15 1.59 0a.37.37 0 0 0 .1.401a.46.46 0 0 1 0 .59a.9.9 0 0 1-.63.35a3.5 3.5 0 0 1-.92.08a4.3 4.3 0 0 1-1-.07a3.5 3.5 0 0 1-.9-.33c.13-.24.26-.47.37-.71q.115-.243.19-.5q.037-.13.06-.26c.36.196.743.347 1.14.45m-4.911.401q.367.264.77.47q.167.078.35.11q.185.015.37 0q.437-.013.87-.07v.23a.35.35 0 0 0 0 .25q-.495.387-.94.83a8 8 0 0 0-.47.64c-.17.26-.32.531-.48.791q0-.35-.06-.69a4 4 0 0 0-.13-.72a5.2 5.2 0 0 0-.56-1.13s.06-.07.07-.11c.06-.22.12-.45.17-.671c.01.07.02.07.04.07"/><path d="M10.883 21.427a6.25 6.25 0 0 0-3.531-.3l-1.18.3l-1.271.18q-.394.015-.78-.06a2.6 2.6 0 0 1-.69-.25c-.41-.21-.69-.46-.74-.77a1.08 1.08 0 0 1 .46-1a3.8 3.8 0 0 1 1.3-.73a4.8 4.8 0 0 1 1.55-.22a.34.34 0 0 0 0-.671a5.4 5.4 0 0 0-1.77.1a4.7 4.7 0 0 0-1.7.75a2.09 2.09 0 0 0-1.001 1.89a2.32 2.32 0 0 0 1.29 1.762c.31.182.648.314 1 .39c.355.075.718.105 1.08.09q.4-.011.791-.08c.25 0 .5-.1.75-.16l1.2-.39a4.85 4.85 0 0 1 2.802 0c.16.07.31.14.35.29s0 .48-.29.84a.383.383 0 0 0 .358.608a.38.38 0 0 0 .252-.148a1.8 1.8 0 0 0 .51-1.52a1.4 1.4 0 0 0-.74-.9"/></g></svg>`;

export default class CrispTempoPlugin extends Plugin {
  unloaded = false;

  async onload(): Promise<void> {
    console.log("Loading Crisp Tempo plugin v" + this.manifest.version);

    // Other plugins (Crisp Pulse) show task status; tell them only when tasks actually change,
    // not on every save-status update.
    const store = TempoStore.get(this);
    let lastDatabase: unknown = null;
    this.register(store.subscribe(() => {
      const database = store.data?.database ?? null;
      if (database === lastDatabase) return;
      lastDatabase = database;
      this.app.workspace.trigger("crisp-tempo:state");
    }));

    // Register custom Crisp Tempo logo icon
    addIcon("crisp-tempo", TEMPO_ICON_SVG);

    // Register custom workspace view with plugin instance passed
    this.registerView(
      TEMPO_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new TempoView(leaf, this)
    );

    // Left ribbon icon
    this.addRibbonIcon("crisp-tempo", "Crisp Tempo — Tasks, in motion.", () => {
      void this.activateView();
    });

    // Obsidian Commands
    this.addCommand({
      id: "open-tempo-view",
      name: "Open Tempo Task Manager",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "quick-add-task",
      name: "Quick Add Task",
      callback: async () => {
        const leaf = await this.activateView();
        if (leaf) TempoStore.get(this).openQuickAdd(leaf);
      },
    });

    // Register Obsidian Settings Tab
    this.addSettingTab(new CrispTempoSettingTab(this.app, this));
  }

  async activateView(): Promise<WorkspaceLeaf | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(TEMPO_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({
        type: TEMPO_VIEW_TYPE,
        active: true,
      });
    }

    if (leaf) {
      workspace.setActiveLeaf(leaf, { focus: true });
      await workspace.revealLeaf(leaf);
    }
    return leaf;
  }

  /* ---------- Public API for other plugins (Crisp Pulse) ---------- */

  private async readyStore(): Promise<TempoStore> {
    if (this.unloaded) throw new Error("Crisp Tempo 已停用");
    const store = TempoStore.get(this);
    if (store.status !== "ready" || !store.data) await store.load();
    if (store.status !== "ready" || !store.data) throw new Error(`Crisp Tempo 数据未能加载：${store.loadError ?? "未知原因"}`);
    return store;
  }

  /**
   * Creates (or returns the existing) task for an item from another plugin. Resolves only after
   * the task is on disk, so a caller never records a task that a failed save lost.
   */
  async createTaskFromSource(input: SourceTaskInput): Promise<SourceTaskSnapshot> {
    const store = await this.readyStore();
    const data = store.data!;
    const existing = findSourceTask(data.database, input.sourceId);
    if (!existing && data.licenseStatus !== "valid") throw new Error("新建任务需要先激活 Crisp Tempo");
    const now = Date.now();
    const result = upsertSourceTask(data.database, input, {
      dest: data.defaultDest === "today" ? "today" : "inbox",
      today: getTodayString(),
      now,
      id: `task-${now}-${Math.random().toString(36).substring(2, 6)}`,
    });
    // Not added to Tempo's undo history: undoing there would silently drop a task another plugin points to.
    if (result.created) store.updateDatabase(() => result.db, false);
    await store.flush();
    if (store.hasPendingSave) throw new Error(`Crisp Tempo 保存失败：${store.saveError ?? "未知原因"}`);
    return toSourceSnapshot(result.task);
  }

  /** Current state of tasks created from these sources; deleted tasks are absent. */
  async getTasksBySource(sourceIds: readonly string[]): Promise<Record<string, SourceTaskSnapshot>> {
    const store = await this.readyStore();
    const wanted = new Set(sourceIds);
    const out: Record<string, SourceTaskSnapshot> = {};
    for (const task of Object.values(store.data!.database.tasks)) {
      if (task.sourceId && wanted.has(task.sourceId)) out[task.sourceId] = toSourceSnapshot(task);
    }
    return out;
  }

  /** Opens Tempo with the task selected. */
  async revealTask(taskId: string): Promise<void> {
    const store = await this.readyStore();
    if (!store.data!.database.tasks[taskId]) throw new Error("这个任务在 Tempo 里已经不存在");
    await this.activateView();
    store.revealTask(taskId);
  }

  async onunload(): Promise<void> {
    this.unloaded = true;
    this.app.workspace.trigger("crisp-tempo:state");
    console.log("Unloading Crisp Tempo plugin");
    await TempoStore.get(this).flush();
  }
}

class CrispTempoSettingTab extends PluginSettingTab {
  plugin: CrispTempoPlugin;
  private licenseDraft = "";
  private isCheckingLicense = false;

  constructor(app: App, plugin: CrispTempoPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const store = TempoStore.get(this.plugin);
    // The store is normally loaded by the Tempo view. Opening these settings before the view
    // left it empty, so language, destination and even a successful license activation were
    // silently discarded. Load it first and redraw once it is ready.
    if (store.status !== "ready" || !store.data) {
      if (store.status !== "error") {
        void store.load().then(
          () => this.display(),
          () => this.display(),
        );
      }
      containerEl.createEl("p", {
        text: store.status === "error"
          ? t("loadErrorTitle", store.loadLocale ?? "zh")
          : t("loading", store.loadLocale ?? "zh"),
        cls: "setting-item-description",
      });
      return;
    }
    const data = store.data;
    const locale = data.locale || "zh";

    const headerEl = containerEl.createDiv({ cls: "tempo-settings-tab-header" });
    headerEl.createEl("h2", { text: `Crisp Tempo (v${this.plugin.manifest.version})` });
    containerEl.createEl("p", {
      text: "Tasks, in motion.",
      cls: "tempo-settings-tab-subhead",
    });

    // 0. Quick Open View Action
    new Setting(containerEl)
      .setName(locale === "en" ? "Open Tempo Workspace" : "打开 Crisp Tempo 任务看板")
      .setDesc(locale === "en" ? "Open the full Tempo task manager in a new tab." : "在工作区新标签页中打开 Tempo 全功能交互面板。")
      .addButton((btn) => {
        btn
          .setButtonText(locale === "en" ? "Open Board" : "打开看板")
          .setCta()
          .onClick(async () => {
            (this.app as any).setting?.close?.();
            await this.plugin.activateView();
          });
      });

    // 1. Software License & Activation
    containerEl.createEl("h3", { text: t("licenseSettings", locale) });

    const isValid = data?.licenseStatus === "valid";
    const statusSetting = new Setting(containerEl).setName(t("licenseStatus", locale));

    if (isValid && data?.licensePayload) {
      const user = data.licensePayload.userName || t("defaultUserName", locale);
      const expiry = data.licensePayload.expiresAt
        ? ` · ${t("licenseExpires", locale)}: ${String(data.licensePayload.expiresAt).split("T")[0]}`
        : ` · ${t("licenseNeverExpires", locale)}`;
      statusSetting.setDesc(`✅ ${t("licenseActive", locale)}（${t("licenseUser", locale)}: ${user}${expiry}）`);
      statusSetting.addButton((btn) => {
        btn
          .setButtonText(t("clearLicenseBtn", locale))
          .setWarning()
          .onClick(async () => {
            await store.clearLicense();
            this.licenseDraft = "";
            new Notice(t("licenseCleared", locale));
            this.display();
          });
      });
    } else {
      statusSetting.setDesc(`❌ ${t("licenseUnlicensed", locale)}（${t("licenseDesc", locale)}）`);
    }

    new Setting(containerEl)
      .setName(t("licenseKey", locale))
      .setDesc(t("licenseDesc", locale))
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder(t("licensePlaceholder", locale))
          .setValue(this.licenseDraft || data?.licenseKey || "")
          .onChange((val) => {
            this.licenseDraft = val.trim();
          });
      })
      .addButton((btn) => {
        btn
          .setButtonText(this.isCheckingLicense ? t("activatingBtn", locale) : t("activateBtn", locale))
          .setCta()
          .setDisabled(this.isCheckingLicense)
          .onClick(async () => {
            const codeToVerify = this.licenseDraft || data?.licenseKey;
            if (!codeToVerify) {
              new Notice(t("licenseEmpty", locale));
              return;
            }
            this.isCheckingLicense = true;
            this.display();
            try {
              const res = await store.activateLicense(codeToVerify);
              if (res.valid && res.payload) {
                new Notice(tf("licenseSuccess", locale, { user: res.payload.userName || t("defaultUserName", locale) }));
              } else {
                new Notice(tf("licenseFailed", locale, { reason: res.reason || t("unknownReason", locale) }));
              }
            } catch (err: any) {
              new Notice(tf("licenseFailed", locale, { reason: err?.message || String(err) }));
            } finally {
              this.isCheckingLicense = false;
              this.display();
            }
          });
      });

    // 2. Preferences
    containerEl.createEl("h3", { text: t("generalSettings", locale) });

    new Setting(containerEl)
      .setName(t("language", locale))
      .setDesc(t("languageDesc", locale))
      .addDropdown((dd) => {
        dd.addOption("zh", t("languageZh", locale))
          .addOption("en", t("languageEn", locale))
          .setValue(locale)
          .onChange((val) => {
            store.setLocale(val as any);
            this.display();
          });
      });

    new Setting(containerEl)
      .setName(t("defaultDestination", locale))
      .setDesc(t("defaultDestDesc", locale))
      .addDropdown((dd) => {
        dd.addOption("inbox", t("inbox", locale))
          .addOption("today", t("today", locale))
          .setValue(data?.defaultDest || "inbox")
          .onChange((val) => {
            store.setDefaultDest(val as any);
          });
      });

    // 3. Data & Storage
    containerEl.createEl("h3", { text: t("dataSettings", locale) });

    new Setting(containerEl)
      .setName(t("exportFolder", locale))
      .setDesc(t("exportFolderDesc", locale))
      .addText((text) => {
        text
          .setPlaceholder(t("exportFolderPlaceholder", locale))
          .setValue(data?.exportFolder || "")
          .onChange((val) => {
            store.setExportFolder(val);
          });
      });

    new Setting(containerEl)
      .setName(t("exportData", locale))
      .setDesc(
        data?.exportFolder
          ? tf("exportDestInfo", locale, { path: data.exportFolder })
          : t("exportRootInfo", locale)
      )
      .addButton((btn) => {
        btn
          .setButtonText(t("exportData", locale))
          .onClick(async () => {
            try {
              const target = await store.exportRawData();
              new Notice(tf("exportDone", locale, { path: target }));
            } catch (err: any) {
              new Notice(tf("exportFailed", locale, { detail: err?.message || String(err) }));
            }
          });
      });

    // 4. About Card & Author Info
    const aboutCard = containerEl.createDiv({ cls: "crisp-tempo-about" });
    aboutCard.createDiv({ cls: "crisp-tempo-about__title", text: t("aboutTempo", locale) });
    aboutCard.createDiv({
      cls: "crisp-tempo-about__description",
      text: "Tasks, in motion.",
    });
    const byline = aboutCard.createEl("p", { cls: "crisp-tempo-about__author" });
    byline.createSpan({ text: t("authorLabel", locale) });
    const authorLink = byline.createEl("a", {
      cls: "crisp-tempo-about__author-link",
      text: t("authorLink", locale),
      href: "https://xhslink.cn/m/3MwtKu4822b",
    });
    authorLink.target = "_blank";
    authorLink.rel = "noopener noreferrer";
  }
}
