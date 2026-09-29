// Bundles src/ into a browser-loadable harness that exposes the App and the store on window,
// so the Playwright evidence scripts can drive the real UI against a mock plugin.
//
// Usage: node scripts/build-audit.mjs [output-directory]
// Default output directory is a temporary folder.
import esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "crisp-tempo-audit"));
fs.mkdirSync(outDir, { recursive: true });

// The harness runs in a plain browser page, so the runtime pieces of the `obsidian` module
// that the UI touches need a stand-in. Notices are recorded on window for assertions.
const stubPath = path.join(outDir, "obsidian-stub.js");
fs.writeFileSync(
  stubPath,
  `export class Notice {
  constructor(message) { (window.__tempoNotices ||= []).push(String(message)); }
  setMessage(message) { (window.__tempoNotices ||= []).push(String(message)); }
  hide() {}
}
export function normalizePath(p) { return p; }
export function addIcon() {}
export function requestUrl() { return Promise.reject(new Error("offline in test")); }
export const Platform = { isMobile: false, isDesktop: true, isMobileApp: false };
export class Menu {
  constructor() { this.items = []; }
  addItem(cb) {
    const item = { title: "", setTitle(t) { this.title = t; return this; }, setIcon() { return this; },
      onClick(fn) { this.fn = fn; return this; } };
    cb(item); this.items.push(item); return this;
  }
  showAtMouseEvent() { window.__tempoMenu = this; }
}
`,
);

const entryCode = `
import { h, render } from "preact";
import { App } from "./src/ui/App";
import * as store from "./src/core/store";
import { createInitialMockDatabase } from "./src/core/mock-data";

(window as any).tempoAudit = {
  mount: (plugin: any, leafOrId?: any, maybeId = "app") => {
    const id = typeof leafOrId === "string" ? leafOrId : (maybeId || "app");
    const leaf = typeof leafOrId === "object" ? leafOrId : undefined;
    return render(h(App, { plugin, leaf }), document.getElementById(id)!);
  },
  unmount: (id = "app") => {
    render(null, document.getElementById(id)!);
    const p = (window as any).plugin;
    if (p) {
      const s = store.TempoStore.get(p);
      void s.flush();
      (s as any).status = "loading";
      (s as any).data = null;
    }
  },
  store: {
    ...store,
    popUndoState: () => {
      const p = (window as any).plugin;
      const s = p ? store.TempoStore.get(p) : null;
      return s ? s.popUndo() : null;
    },
  },
  mock: createInitialMockDatabase,
};
`;

await esbuild.build({
  stdin: { contents: entryCode, resolveDir: projectRoot, loader: "tsx" },
  bundle: true,
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  jsxImportSource: "preact",
  alias: { obsidian: stubPath },
  outfile: path.join(outDir, "audit-app.js"),
  sourcemap: true,
});

console.log(
  `Built audit-app.js (${fs.statSync(path.join(outDir, "audit-app.js")).size} bytes) -> ${outDir}`,
);
