import { FileSystemAdapter, Platform, type Plugin } from "obsidian";
import helperBase64 from "tempo-apple-helper";

/**
 * Runs native/tempo-apple-helper, the EventKit program embedded in main.js. Obsidian installs only
 * main.js, manifest.json and styles.css, so the helper is written next to them on first use and
 * rewritten whenever its bytes differ from the embedded copy. Node modules are required lazily:
 * on mobile they do not exist and this file must still load.
 */

const HELPER_NAME = "tempo-apple-helper";
const TIMEOUT_MS = 30_000;
/** Long enough for the user to answer the macOS permission prompt. */
const ACCESS_TIMEOUT_MS = 180_000;

export class AppleHelperError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function appleHelperSupported(): boolean {
  return Platform.isDesktopApp && Platform.isMacOS;
}

type NodeRequire = (id: string) => any;
const nodeRequire = (): NodeRequire => {
  const req = (window as unknown as { require?: NodeRequire }).require;
  if (!req) throw new AppleHelperError("unsupported", "Node modules are not available here.");
  return req;
};

let installed: Promise<string> | null = null;

function helperPath(plugin: Plugin): string {
  const adapter = plugin.app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter) || !plugin.manifest.dir) {
    throw new AppleHelperError("unsupported", "The vault is not on the local file system.");
  }
  const path = nodeRequire()("path");
  return path.join(adapter.getBasePath(), plugin.manifest.dir, HELPER_NAME);
}

/** Writes the helper when it is missing or differs from the embedded bytes. Once per session. */
function install(plugin: Plugin): Promise<string> {
  installed ??= (async () => {
    const fs = nodeRequire()("fs");
    const crypto = nodeRequire()("crypto");
    const target = helperPath(plugin);
    const bytes: Buffer = Buffer.from(helperBase64, "base64");
    const hash = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");
    let current: Buffer | null = null;
    try {
      current = fs.readFileSync(target);
    } catch {
      current = null;
    }
    if (!current || hash(current) !== hash(bytes)) {
      const temp = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(temp, bytes, { mode: 0o755 });
      fs.renameSync(temp, target);
    }
    fs.chmodSync(target, 0o755);
    return target;
  })();
  installed.catch(() => {
    installed = null;
  });
  return installed;
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text.trim());
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Runs one helper command and resolves with its JSON answer; failures reject with AppleHelperError. */
export async function runAppleHelper<T = Record<string, unknown>>(
  plugin: Plugin,
  command: string,
  request?: unknown,
): Promise<T> {
  if (!appleHelperSupported()) throw new AppleHelperError("unsupported", "Reminders and Calendar need Obsidian on macOS.");
  const file = await install(plugin);
  const { execFile } = nodeRequire()("child_process");
  const timeout = command === "request-access" ? ACCESS_TIMEOUT_MS : TIMEOUT_MS;
  return new Promise<T>((resolve, reject) => {
    const child = execFile(
      file,
      [command],
      { timeout, maxBuffer: 16 * 1024 * 1024 },
      (err: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string, stderr: string) => {
        const answer = parse(String(stdout ?? ""));
        if (answer && answer.ok === false) {
          reject(new AppleHelperError(String(answer.code ?? "helper_error"), String(answer.message ?? "The helper failed.")));
          return;
        }
        if (err) {
          if (err.killed) reject(new AppleHelperError("timeout", "Reminders and Calendar did not answer in time."));
          else reject(new AppleHelperError(String(err.code ?? "helper_error"), String(stderr || err.message)));
          return;
        }
        if (!answer) {
          reject(new AppleHelperError("invalid_json", "The helper answered with something that is not JSON."));
          return;
        }
        resolve(answer as T);
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(request === undefined ? "" : JSON.stringify(request));
  });
}
