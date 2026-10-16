// License check regressions. Runs the real src/services/license.ts in Node with a locally
// generated Ed25519 key swapped in for the production public key, so real signatures are
// verified without any production secret and without touching the network.
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

const outDir = mkdtempSync(path.join(tmpdir(), "tempo-license-"));
const stub = path.join(outDir, "obsidian-stub.mjs");
writeFileSync(stub, "export const requestUrl = undefined;\n");
await esbuild.build({
  entryPoints: [path.join(root, "src/services/license.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: path.join(outDir, "license.mjs"),
  logLevel: "error",
  alias: { obsidian: stub },
  plugins: [{
    name: "test-public-key",
    setup(build) {
      build.onLoad({ filter: /license\.ts$/ }, (args) => {
        const source = readFileSync(args.path, "utf8");
        // Only the backtick-delimited constant, never the header strings used by the parser.
        const swapped = source.replace(/`-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----`/, `\`${testPem}\``);
        assert.notEqual(swapped, source, "the embedded public key must be replaced");
        return { contents: swapped, loader: "ts" };
      });
    },
  }],
});
const { verifyLicenseCode, discoverVaultCrispLicenses, inheritVaultCrispLicense } = await import(pathToFileURL(path.join(outDir, "license.mjs")).href);

const b64url = (buf) => Buffer.from(buf).toString("base64url");
function makeCode(fields = {}) {
  const payload = b64url(JSON.stringify({
    product: "Crisp Suite", licenseId: "TEST-1", userName: "Tester",
    expiresAt: "2999-01-01T00:00:00.000Z", features: ["all"], ...fields,
  }));
  return `${payload}.${b64url(sign(null, Buffer.from(payload), privateKey))}`;
}
const CODE = makeCode();
// Node has no window/app, so the device id is supplied like the plugin would.
const env = (extra) => ({ getDeviceId: () => "test-device", ...extra });

/** Mimics Obsidian's requestUrl with throw:false: resolves for every status. */
function respond(status, body) {
  const calls = [];
  const request = async (input) => {
    calls.push(input);
    return {
      status,
      get json() {
        if (typeof body === "string") throw new SyntaxError("Unexpected token in JSON");
        return body;
      },
    };
  };
  return { request, calls };
}

test("200 valid:true is accepted online", async () => {
  const { request, calls } = respond(200, { valid: true, message: "ok" });
  const res = await verifyLicenseCode(CODE, "crisp-tempo", env({ request }));
  assert.equal(res.valid, true);
  assert.equal(res.source, "online");
  assert.equal(calls.length, 1);
});

test("the request asks requestUrl not to throw on 4xx", async () => {
  const { request, calls } = respond(200, { valid: true });
  await verifyLicenseCode(CODE, "crisp-tempo", env({ request }));
  assert.equal(calls[0].throw, false, "without throw:false a 403 becomes an exception and fails open");
});

for (const [status, reason] of [
  [200, "该卡密激活设备数已达上限 (2/2)"],
  [400, "授权码格式无效"],
  [401, "签名无效"],
  [403, "该授权已被吊销，如有疑问请联系卖家"],
  [403, "该卡密累计激活次数已达上限 (5/5)"],
  [403, "该授权码未包含此插件权限"],
]) {
  test(`${status} valid:false is a denial (${reason})`, async () => {
    const { request } = respond(status, { valid: false, reason });
    const res = await verifyLicenseCode(CODE, "crisp-tempo", env({ request }));
    assert.equal(res.valid, false);
    assert.equal(res.reason, reason);
  });
}

test("503 stays fail-open: the service being down is not a denial", async () => {
  const { request } = respond(503, { valid: false, errorType: "server_error", reason: "授权服务暂不可用" });
  const res = await verifyLicenseCode(CODE, "crisp-tempo", env({ request }));
  assert.equal(res.valid, true);
});

test("a 403 without a JSON verdict is not treated as a denial", async () => {
  const { request } = respond(403, "<html>blocked by proxy</html>");
  const res = await verifyLicenseCode(CODE, "crisp-tempo", env({ request }));
  assert.equal(res.valid, true);
});

test("a network error falls back to the local signature", async () => {
  const request = async () => { throw new Error("net::ERR_INTERNET_DISCONNECTED"); };
  const res = await verifyLicenseCode(CODE, "crisp-tempo", env({ request }));
  assert.equal(res.valid, true);
  assert.equal(res.source, "offline");
});

test("a hanging request times out and falls back instead of waiting forever", async () => {
  const request = () => new Promise(() => {});
  const started = Date.now();
  const res = await verifyLicenseCode(CODE, "crisp-tempo", env({ request, timeoutMs: 150 }));
  assert.equal(res.valid, true);
  assert.equal(res.source, "offline");
  assert.ok(Date.now() - started < 2000, "must not wait for the hung request");
});

test("offline mode never calls the service", async () => {
  const { request, calls } = respond(403, { valid: false, reason: "revoked" });
  const res = await verifyLicenseCode(CODE, "crisp-tempo", env({ request, online: false }));
  assert.equal(res.valid, true);
  assert.equal(res.source, "local");
  assert.equal(calls.length, 0);
});

test("local checks reject before any request", async () => {
  const { request, calls } = respond(200, { valid: true });
  const tampered = CODE.slice(0, -4) + (CODE.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.equal((await verifyLicenseCode(tampered, "crisp-tempo", env({ request }))).valid, false);
  const expired = makeCode({ expiresAt: "2000-01-01T00:00:00.000Z" });
  assert.equal((await verifyLicenseCode(expired, "crisp-tempo", env({ request }))).valid, false);
  const otherPlugin = makeCode({ features: ["crisp-mind"] });
  assert.equal((await verifyLicenseCode(otherPlugin, "crisp-tempo", env({ request }))).valid, false);
  assert.equal(calls.length, 0);
});

// ---- Inheritance from sibling Crisp plugins ----

/** Minimal vault: `files` maps paths to contents; `configDir` mirrors app.vault.configDir. */
function fakeApp({ configDir = ".obsidian", files = {}, loaded = {} } = {}) {
  const folders = new Set();
  for (const file of Object.keys(files)) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  return {
    plugins: { plugins: loaded },
    vault: {
      configDir,
      adapter: {
        exists: async (p) => p in files || folders.has(p),
        read: async (p) => {
          if (!(p in files)) throw new Error(`ENOENT ${p}`);
          return files[p];
        },
        list: async (dir) => ({
          files: Object.keys(files).filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes("/")),
          folders: [...folders].filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes("/")),
        }),
      },
    },
  };
}
const dataFile = (code, key = "licenseCode") => JSON.stringify({ [key]: code });

/** Answers per licence code; codes without an entry get `fallback`. */
function respondPerCode(table, fallback = { status: 200, body: { valid: true } }) {
  const calls = [];
  const request = async (input) => {
    const { licenseCode } = JSON.parse(input.body);
    calls.push(licenseCode);
    const { status, body } = table[licenseCode] ?? fallback;
    return { status, json: body };
  };
  return { request, calls };
}

test("discovery returns every locally valid sibling code in order, deduplicated", async () => {
  const A = makeCode({ licenseId: "A" });
  const B = makeCode({ licenseId: "B" });
  const expired = makeCode({ licenseId: "OLD", expiresAt: "2000-01-01T00:00:00.000Z" });
  const app = fakeApp({
    loaded: { "crisp-mind": { settings: { licenseCode: expired } }, "crisp-pulse": { settings: { licenseKey: A } } },
    files: {
      ".obsidian/plugins/crisp-focus/data.json": dataFile(A),
      ".obsidian/plugins/crisp-asr/data.json": dataFile(B, "licenseKey"),
      ".obsidian/plugins/crisp-tempo/data.json": dataFile(makeCode({ licenseId: "SELF" })),
      ".obsidian/plugins/other/data.json": dataFile(makeCode({ licenseId: "NOT-CRISP" })),
    },
  });
  assert.deepEqual(await discoverVaultCrispLicenses(app, "crisp-tempo"), [A, B]);
});

test("discovery reads the configured config directory, not a hard-coded .obsidian", async () => {
  const A = makeCode({ licenseId: "A" });
  const app = fakeApp({
    configDir: ".config-obsidian",
    files: {
      ".config-obsidian/plugins/crisp-focus/data.json": dataFile(A),
      ".obsidian/plugins/crisp-asr/data.json": dataFile(makeCode({ licenseId: "STALE-DIR" })),
    },
  });
  assert.deepEqual(await discoverVaultCrispLicenses(app, "crisp-tempo"), [A]);
});

test("discovery skips excluded codes and stops at the limit", async () => {
  const codes = ["A", "B", "C", "D", "E", "F", "G"].map((id) => makeCode({ licenseId: id }));
  const files = {};
  codes.forEach((code, i) => (files[`.obsidian/plugins/crisp-p${i}/data.json`] = dataFile(code)));
  const app = fakeApp({ files });
  const found = await discoverVaultCrispLicenses(app, "crisp-tempo", { exclude: [codes[0]] });
  assert.deepEqual(found, codes.slice(1, 6), "excluded codes do not take a slot; at most 5 are returned");
  assert.deepEqual(await discoverVaultCrispLicenses(app, "crisp-tempo", { limit: 2 }), codes.slice(0, 2));
});

test("inheritance checks candidates online and skips one the service rejects", async () => {
  const revoked = makeCode({ licenseId: "REVOKED" });
  const good = makeCode({ licenseId: "GOOD" });
  const app = fakeApp({
    files: {
      ".obsidian/plugins/crisp-asr/data.json": dataFile(revoked),
      ".obsidian/plugins/crisp-focus/data.json": dataFile(good),
    },
  });
  const { request, calls } = respondPerCode({ [revoked]: { status: 403, body: { valid: false, reason: "该授权已被吊销" } } });
  const inherited = await inheritVaultCrispLicense(app, "crisp-tempo", { environment: env({ request }) });
  assert.equal(inherited?.code, good);
  assert.equal(inherited?.result.valid, true);
  assert.deepEqual(calls, [revoked, good], "each candidate reaches the licence service, in order");
});

test("inheritance returns nothing when every candidate is rejected online", async () => {
  const revoked = makeCode({ licenseId: "REVOKED" });
  const app = fakeApp({ files: { ".obsidian/plugins/crisp-asr/data.json": dataFile(revoked) } });
  const { request } = respondPerCode({}, { status: 200, body: { valid: false, reason: "设备数已达上限" } });
  assert.equal(await inheritVaultCrispLicense(app, "crisp-tempo", { environment: env({ request }) }), null);
});

test("inheritance still works offline: a network error falls back to the local signature", async () => {
  const good = makeCode({ licenseId: "GOOD" });
  const app = fakeApp({ files: { ".obsidian/plugins/crisp-asr/data.json": dataFile(good) } });
  const request = async () => { throw new Error("net::ERR_INTERNET_DISCONNECTED"); };
  const inherited = await inheritVaultCrispLicense(app, "crisp-tempo", { environment: env({ request }) });
  assert.equal(inherited?.code, good);
  assert.equal(inherited?.result.source, "offline");
});

test("inheritance never offers back the excluded code", async () => {
  const own = makeCode({ licenseId: "OWN" });
  const app = fakeApp({ files: { ".obsidian/plugins/crisp-asr/data.json": dataFile(own) } });
  const { request, calls } = respondPerCode({});
  assert.equal(await inheritVaultCrispLicense(app, "crisp-tempo", { exclude: [own], environment: env({ request }) }), null);
  assert.equal(calls.length, 0);
});
