import { FileSystemAdapter, Platform, type Plugin } from "obsidian";
import helperBase64 from "tempo-apple-helper";

/**
 * Runs native/tempo-apple-helper, the EventKit program embedded in main.js. Obsidian installs only
 * main.js, manifest.json and styles.css, so the helper is written next to them on first use and
 * rewritten whenever its bytes differ from the embedded copy. Node modules are required lazily:
 * on mobile they do not exist and this file must still load.
 *
 * While Reminders or Calendar is on, one helper runs in "serve" mode: EventKit stays open (a call
 * takes milliseconds instead of a fresh process's 100–300 ms) and it reports changes as they happen.
 * Without it, or when it fails, each call starts a helper of its own.
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

function answerOf<T>(answer: Record<string, unknown>): T {
  if (answer.ok === false) {
    throw new AppleHelperError(String(answer.code ?? "helper_error"), String(answer.message ?? "The helper failed."));
  }
  return answer as T;
}

interface Waiting {
  resolve: (answer: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: number;
}

/** The running "serve" helper: one line per request, answers matched by id, change events passed on. */
class HelperServer {
  private child: any;
  private buffer = "";
  private waiting = new Map<number, Waiting>();
  private nextId = 1;
  alive = true;

  constructor(file: string, private onEvent: (event: string) => void, private onExit: () => void) {
    const { spawn } = nodeRequire()("child_process");
    this.child = spawn(file, ["serve"], { stdio: ["pipe", "pipe", "ignore"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.read(chunk));
    this.child.stdin.on("error", () => {});
    this.child.on("error", () => this.end());
    this.child.on("exit", () => this.end());
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const message = parse(line);
      if (!message) continue;
      if (typeof message.event === "string") {
        this.onEvent(message.event);
        continue;
      }
      const waiting = typeof message.id === "number" ? this.waiting.get(message.id) : undefined;
      if (!waiting) continue;
      this.waiting.delete(message.id as number);
      window.clearTimeout(waiting.timer);
      waiting.resolve(message);
    }
  }

  call(command: string, request: unknown, timeout: number): Promise<Record<string, unknown>> {
    if (!this.alive) return Promise.reject(new AppleHelperError("server_gone", "The helper stopped."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.waiting.delete(id);
        reject(new AppleHelperError("timeout", "Reminders and Calendar did not answer in time."));
      }, timeout);
      this.waiting.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, command, request: request ?? {} })}\n`);
    });
  }

  private end(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const waiting of this.waiting.values()) {
      window.clearTimeout(waiting.timer);
      waiting.reject(new AppleHelperError("server_gone", "The helper stopped."));
    }
    this.waiting.clear();
    this.onExit();
  }

  stop(): void {
    this.alive = false;
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch {
      // already gone
    }
  }
}

let server: HelperServer | null = null;

/**
 * Keeps a "serve" helper running and calls `onChange` when Reminders or Calendar change. One that
 * stops on its own is started again after a pause (each pause longer, up to a minute). The returned
 * function stops it.
 */
export function startAppleWatch(plugin: Plugin, onChange: () => void): () => void {
  let stopped = false;
  let restarts = 0;
  let timer: number | null = null;
  const launch = async () => {
    if (stopped || server?.alive) return;
    try {
      const file = await install(plugin);
      if (stopped) return;
      const startedAt = Date.now();
      server = new HelperServer(file, (event) => {
        if (event === "changed") onChange();
      }, () => {
        server = null;
        if (stopped) return;
        // A helper that ran a while counts as healthy again.
        if (Date.now() - startedAt > 60_000) restarts = 0;
        const delay = Math.min(60_000, 2_000 * 2 ** restarts++);
        timer = window.setTimeout(() => void launch(), delay);
      });
    } catch (err) {
      console.warn("Crisp Tempo: could not start the Reminders and Calendar helper", err);
    }
  };
  void launch();
  return () => {
    stopped = true;
    if (timer !== null) window.clearTimeout(timer);
    server?.stop();
    server = null;
  };
}

/** Runs one helper command and resolves with its JSON answer; failures reject with AppleHelperError. */
export async function runAppleHelper<T = Record<string, unknown>>(
  plugin: Plugin,
  command: string,
  request?: unknown,
): Promise<T> {
  if (!appleHelperSupported()) throw new AppleHelperError("unsupported", "Reminders and Calendar need Obsidian on macOS.");
  // The permission prompt can take minutes; it gets a process of its own.
  if (server?.alive && command !== "request-access") {
    try {
      return answerOf<T>(await server.call(command, request, TIMEOUT_MS));
    } catch (err) {
      // Only a helper that went away falls back; a real error or a timeout is the answer.
      if (!(err instanceof AppleHelperError) || err.code !== "server_gone") throw err;
    }
  }
  return runOnce<T>(plugin, command, request);
}

async function runOnce<T>(plugin: Plugin, command: string, request?: unknown): Promise<T> {
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
