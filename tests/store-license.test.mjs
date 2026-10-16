// Licence inheritance as the store runs it on load: the real src/core/store.ts against an
// in-memory vault. A locally generated Ed25519 key replaces the production public key and the
// licence service is a stub, so nothing here reaches the network or reads a production secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const testPem = publicKey.export({ type: "spki", format: "pem" }).trim();

const outDir = mkdtempSync(path.join(tmpdir(), "tempo-store-license-"));
const stub = path.join(outDir, "obsidian-stub.mjs");
// requestUrl is what verifyLicenseCode uses by default; each test installs its own handler.
writeFileSync(stub, [
  "export const normalizePath = (p) => p.replace(/\\\\/g, '/').replace(/\\/+/g, '/');",
  "export const requestUrl = (input) => globalThis.__tempoRequest(input);",
].join("\n"));
const entry = path.join(outDir, "entry.ts");
writeFileSync(entry, [
  `export { TempoStore } from ${JSON.stringify(path.join(root, "src/core/store.ts"))};`,
  `export { createEmptyDatabase } from ${JSON.stringify(path.join(root, "src/core/mock-data.ts"))};`,
].join("\n"));
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "store.mjs"),
  logLevel: "error",
  alias: { obsidian: stub },
  plugins: [{
    name: "test-public-key",
    setup(build) {
      build.onLoad({ filter: /services[\\/]license\.ts$/ }, (args) => {
        const source = readFileSync(args.path, "utf8");
        const swapped = source.replace(/`-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----`/, `\`${testPem}\``);
        assert.notEqual(swapped, source, "the embedded public key must be replaced");
        return { contents: swapped, loader: "ts" };
      });
    },
  }],
});
// The plugin reads its device id from window.app in Obsidian.
globalThis.window = { app: { appId: "test-device" } };
const { TempoStore, createEmptyDatabase } = await import(pathToFileURL(path.join(outDir, "store.mjs")).href);

const b64url = (buf) => Buffer.from(buf).toString("base64url");
function makeCode(fields = {}) {
  const payload = b64url(JSON.stringify({
    product: "Crisp Suite", licenseId: "TEST-1", userName: "Tester",
    expiresAt: "2999-01-01T00:00:00.000Z", features: ["all"], ...fields,
  }));
  return `${payload}.${b64url(sign(null, Buffer.from(payload), privateKey))}`;
}

const TEMPO_DATA = ".obsidian/plugins/crisp-tempo/data.json";
const siblingData = (id) => `.obsidian/plugins/${id}/data.json`;

/** Tempo plugin with data.json and sibling plugin files in an in-memory vault. */
function setup({ tempo = {}, siblings = {}, answers = {}, fallback = { status: 200, body: { valid: true } }, offline = false }) {
  const files = {
    [TEMPO_DATA]: JSON.stringify({ schemaVersion: 1, locale: "zh", database: createEmptyDatabase(), ...tempo }),
  };
  for (const [id, code] of Object.entries(siblings)) files[siblingData(id)] = JSON.stringify({ licenseCode: code });
  const folders = () => {
    const set = new Set();
    for (const file of Object.keys(files)) {
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join("/"));
    }
    return set;
  };
  const children = (dir, list) => list.filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"));
  const adapter = {
    exists: async (p) => p in files || folders().has(p),
    read: async (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    write: async (p, text) => { files[p] = text; },
    stat: async (p) => (p in files ? { size: Buffer.byteLength(files[p]) } : null),
    list: async (dir) => ({ files: children(dir, Object.keys(files)), folders: children(dir, [...folders()]) }),
    remove: async (p) => { delete files[p]; },
  };
  const calls = [];
  globalThis.__tempoRequest = async (input) => {
    const { licenseCode } = JSON.parse(input.body);
    calls.push(licenseCode);
    if (offline) throw new Error("net::ERR_INTERNET_DISCONNECTED");
    const { status, body } = answers[licenseCode] ?? fallback;
    return { status, json: body };
  };
  const plugin = {
    manifest: { id: "crisp-tempo", dir: ".obsidian/plugins/crisp-tempo" },
    app: { plugins: { plugins: {} }, vault: { configDir: ".obsidian", adapter } },
    loadData: async () => JSON.parse(files[TEMPO_DATA]),
    saveData: async (data) => { files[TEMPO_DATA] = JSON.stringify(data); },
  };
  const store = new TempoStore(plugin);
  return { store, calls, saved: () => JSON.parse(files[TEMPO_DATA]) };
}

/** Waits until the background licence work has made `count` service calls and settled. */
async function afterCalls(calls, count) {
  for (let i = 0; i < 200 && calls.length < count; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, count, "expected number of licence service calls");
  await new Promise((r) => setTimeout(r, 30));
}

const DENIED = { status: 403, body: { valid: false, reason: "该授权已被吊销" } };

test("an inherited code is checked online and a revoked one is not inherited", async () => {
  const revoked = makeCode({ licenseId: "REVOKED" });
  const { store, calls, saved } = setup({ siblings: { "crisp-asr": revoked }, answers: { [revoked]: DENIED } });
  await store.load();
  await afterCalls(calls, 1);
  assert.deepEqual(calls, [revoked], "inheritance must reach the licence service");
  assert.equal(store.data.licenseKey, undefined, "a revoked sibling code must not be inherited");
  assert.notEqual(store.data.licenseStatus, "valid");
  await store.flush();
  assert.equal(saved().licenseKey, undefined, "and must not be written to data.json");
});

test("an inherited code that passes online unlocks and is saved", async () => {
  const good = makeCode({ licenseId: "GOOD" });
  const { store, calls, saved } = setup({ siblings: { "crisp-asr": good } });
  await store.load();
  await afterCalls(calls, 1);
  assert.equal(store.data.licenseKey, good);
  assert.equal(store.data.licenseStatus, "valid");
  await store.flush();
  assert.equal(saved().licenseKey, good);
});

test("inheritance works offline by falling back to the local signature", async () => {
  const good = makeCode({ licenseId: "GOOD" });
  const { store, calls } = setup({ siblings: { "crisp-asr": good }, offline: true });
  await store.load();
  await afterCalls(calls, 1);
  assert.equal(store.data.licenseKey, good);
  assert.equal(store.data.licenseStatus, "valid");
});

test("a rejected first candidate does not block a valid later one", async () => {
  const revoked = makeCode({ licenseId: "REVOKED" });
  const good = makeCode({ licenseId: "GOOD" });
  const { store, calls } = setup({
    siblings: { "crisp-asr": revoked, "crisp-focus": good },
    answers: { [revoked]: DENIED },
  });
  await store.load();
  await afterCalls(calls, 2);
  assert.deepEqual(calls, [revoked, good]);
  assert.equal(store.data.licenseKey, good);
  assert.equal(store.data.licenseStatus, "valid");
});

test("an expired stored code is replaced by a valid sibling code", async () => {
  const expired = makeCode({ licenseId: "OLD", expiresAt: "2000-01-01T00:00:00.000Z" });
  const renewed = makeCode({ licenseId: "NEW" });
  const { store, calls, saved } = setup({
    tempo: { licenseKey: expired, licenseStatus: "valid" },
    siblings: { "crisp-asr": renewed },
  });
  await store.load();
  await afterCalls(calls, 1);
  assert.deepEqual(calls, [renewed], "the expired code is rejected locally, the sibling online");
  assert.equal(store.data.licenseKey, renewed);
  assert.equal(store.data.licenseStatus, "valid");
  await store.flush();
  assert.equal(saved().licenseKey, renewed);
});

test("a stored code revoked online is replaced, and is never retried as a candidate", async () => {
  const revoked = makeCode({ licenseId: "REVOKED" });
  const renewed = makeCode({ licenseId: "NEW" });
  const { store, calls } = setup({
    tempo: { licenseKey: revoked, licenseStatus: "valid" },
    siblings: { "crisp-asr": revoked, "crisp-focus": renewed },
    answers: { [revoked]: DENIED },
  });
  await store.load();
  await afterCalls(calls, 2);
  assert.deepEqual(calls, [revoked, renewed]);
  assert.equal(store.data.licenseKey, renewed);
  assert.equal(store.data.licenseStatus, "valid");
});

test("a stored code revoked online with no valid replacement stays invalid", async () => {
  const revoked = makeCode({ licenseId: "REVOKED" });
  const { store, calls } = setup({ tempo: { licenseKey: revoked, licenseStatus: "valid" }, answers: { [revoked]: DENIED } });
  await store.load();
  await afterCalls(calls, 1);
  assert.equal(store.data.licenseKey, revoked);
  assert.equal(store.data.licenseStatus, "invalid");
});

test("a stored code that passes online is kept and siblings are not consulted", async () => {
  const own = makeCode({ licenseId: "OWN" });
  const other = makeCode({ licenseId: "OTHER" });
  const { store, calls } = setup({ tempo: { licenseKey: own, licenseStatus: "valid" }, siblings: { "crisp-asr": other } });
  await store.load();
  await afterCalls(calls, 1);
  assert.deepEqual(calls, [own]);
  assert.equal(store.data.licenseKey, own);
  assert.equal(store.data.licenseStatus, "valid");
});

test("after the user deactivates, a sibling code is not inherited", async () => {
  const good = makeCode({ licenseId: "GOOD" });
  const { store, calls } = setup({ tempo: { licenseStatus: "unlicensed" }, siblings: { "crisp-asr": good } });
  await store.load();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls.length, 0);
  assert.equal(store.data.licenseKey, undefined);
  assert.equal(store.data.licenseStatus, "unlicensed");
});

test("deactivating while an inheritance check is in flight wins", async () => {
  const good = makeCode({ licenseId: "GOOD" });
  const { store, calls } = setup({ siblings: { "crisp-asr": good } });
  let release;
  const gate = new Promise((r) => (release = r));
  const original = globalThis.__tempoRequest;
  globalThis.__tempoRequest = async (input) => {
    const res = await original(input);
    await gate;
    return res;
  };
  await store.load();
  for (let i = 0; i < 200 && calls.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
  await store.clearLicense();
  release();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.data.licenseKey, undefined);
  assert.equal(store.data.licenseStatus, "unlicensed");
});
