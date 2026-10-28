import type { App } from "obsidian";

export type OutcomeTarget =
  | { kind: "url"; url: string }
  | { kind: "note"; linkpath: string; subpath: string };

/**
 * Reads what the user typed as a task's outcome: a URL ("https://…", "obsidian://…") or a note,
 * written as a name, a vault path or a wikilink ("[[Note#Heading|alias]]").
 */
export function parseOutcomeLink(raw: string): OutcomeTarget | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { kind: "url", url: text };
  const inner = text.replace(/^!?\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
  const hash = inner.indexOf("#");
  const linkpath = (hash >= 0 ? inner.slice(0, hash) : inner).trim();
  if (!linkpath) return null;
  return { kind: "note", linkpath, subpath: hash >= 0 ? inner.slice(hash) : "" };
}

/**
 * Opens an outcome. A note that does not resolve is reported rather than opened, because
 * opening an unresolved link would create an empty note under that name.
 * Resolves to the missing note's name, or null when something was opened.
 */
export async function openOutcomeLink(app: App, raw: string): Promise<string | null> {
  const target = parseOutcomeLink(raw);
  if (!target) return raw.trim();
  if (target.kind === "url") {
    window.open(target.url, "_blank");
    return null;
  }
  const file = app.metadataCache?.getFirstLinkpathDest(target.linkpath, "");
  if (!file) return target.linkpath;
  await app.workspace.openLinkText(file.path + target.subpath, "", false);
  return null;
}
