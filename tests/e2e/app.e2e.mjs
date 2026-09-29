// End-to-end suite: drives the real App component in Chromium against a mock Obsidian
// plugin and an in-memory vault adapter. Run with `npm run test:e2e`.
//
// Browser: TEMPO_E2E_CHROME if set, else Playwright's default Chromium, else the newest
// Chromium already present in the Playwright browser cache.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'crisp-tempo-e2e-'));
execFileSync(process.execPath, [path.join(root, 'scripts/build-audit.mjs'), out], { stdio: 'ignore' });
const host = JSON.parse(fs.readFileSync(path.join(here, 'obsidian-host-context.json'), 'utf8'));
const STYLES = path.join(root, 'styles.css');
const PLUGIN_DIR = '.obsidian/plugins/crisp-tempo';
const DATA_PATH = PLUGIN_DIR + '/data.json';

function chromePath() {
  if (process.env.TEMPO_E2E_CHROME) return process.env.TEMPO_E2E_CHROME;
  const preferred = chromium.executablePath();
  if (fs.existsSync(preferred)) return preferred;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const candidates = fs.existsSync(cache)
    ? fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1])
    : [];
  for (const dir of candidates) {
    const exe = path.join(cache, dir, preferred.split(/chromium-\d+/)[1]);
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('No Chromium found. Set TEMPO_E2E_CHROME or run `npx playwright install chromium`.');
}

const browser = await chromium.launch({ headless: true, executablePath: chromePath() });


const results = [];
const pageErrors = [];

/**
 * Boots the real App against a mock plugin.
 * `adapterRaw` selects what sits in the mock adapter's data.json:
 *   'none' | 'fixture' | 'corrupt' | any literal string
 */
async function boot({
  width = 1280, height = 900, mobile = false, paneWidth = width, mount = true,
  loadFail = false, saveFail = false, invalid = false, futureSchema = false, clockTime,
  adapter = false, adapterRaw = 'none', writeMode = 'ok', expectError = undefined, licensed = true,
} = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, isMobile: mobile, hasTouch: mobile, timezoneId: 'Asia/Singapore',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  page.on('pageerror', (e) => pageErrors.push(e.message));

  if (clockTime) await page.clock.install({ time: new Date(clockTime) });

  await page.setContent(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body><div id="app" class="tempo-view-container"></div>' +
    '<div id="app2" class="tempo-view-container" style="display:none"></div>' +
    '<button id="outside">Other pane</button></body></html>',
  );
  await page.addStyleTag({ content: `:root{${host.vars.map(([k, v]) => `${k}:${v};`).join('')}}` });
  await page.addStyleTag({ path: STYLES });
  await page.addStyleTag({
    content: `*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}` +
      `#app{width:${paneWidth}px;height:100%;position:relative}` +
      `#app2{width:50%;height:100%;position:absolute;right:0;top:0}` +
      `#outside{position:fixed;bottom:0;right:0;z-index:20000}`,
  });
  await page.evaluate((m) => {
    document.body.className = 'theme-light';
    if (m) document.body.classList.add('is-mobile', 'is-phone');
  }, mobile);
  await page.addScriptTag({ path: path.join(out, 'audit-app.js') });

  await page.evaluate(
    ({ loadFail, saveFail, invalid, futureSchema, adapter, adapterRaw, pluginDir, dataPath, writeMode }) => {
      const date = (n) => {
        const d = new Date(); d.setDate(d.getDate() + n);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      const base = (id, title, fields = {}) => ({
        id, title, status: 'todo', triage: 'processed', availability: 'anytime', priority: 'none',
        focusDate: date(0), createdAt: Date.now(), updatedAt: Date.now(), order: id, ...fields,
      });
      const db = {
        schemaVersion: 1,
        tasks: {
          'task-1': base('task-1', 'Primary Task', { projectId: 'p1', dueDate: date(0) }),
          'task-2': base('task-2', 'Inbox Task', { triage: 'inbox', focusDate: undefined, dueDate: date(4) }),
          'task-3': base('task-3', 'Plain Task', { focusDate: undefined }),
          'task-4': base('task-4', 'Done Task', { status: 'done', completedAt: Date.now() - 4 * 86400000, focusDate: undefined }),
        },
        projects: {
          p1: {
            id: 'p1', title: 'Very long sample project title for mobile layout', status: 'active',
            priority: 'none', createdAt: Date.now(), updatedAt: Date.now(), order: 'a',
          },
        },
        cycles: {
          'cycle-1': { id: 'cycle-1', title: 'Current Cycle', startDate: date(0), endDate: date(6), status: 'current' },
        },
        areas: {}, labels: {},
      };
      if (invalid) db.tasks['bad'] = null;

      const disk = { schemaVersion: futureSchema ? 2 : 1, locale: 'zh', defaultDest: 'inbox', database: db };
      const files = {};
      if (adapterRaw === 'fixture') files[dataPath] = JSON.stringify(disk, null, 2);
      else if (adapterRaw === 'corrupt') files[dataPath] = '{ "schemaVersion": 1, "database": { "tasks": {';
      else if (adapterRaw !== 'none') files[dataPath] = adapterRaw;

      window.fixture = {
        disk: structuredClone(disk), writes: [], loadCalls: 0, saveFail, loadFail,
        delayByTitle: {}, adapterWrites: [], adapterFiles: files, corruptBytes: files[dataPath],
      };
      window.leaf1 = { id: 'first' };
      window.leaf2 = { id: 'second' };

      window.plugin = {
        manifest: { dir: pluginDir, version: '0.1.0' },
        app: {
          workspace: { activeLeaf: window.leaf1 },
          vault: {
            adapter: adapter ? {
              files,
              async exists(p) { return Object.prototype.hasOwnProperty.call(files, p); },
              async read(p) {
                if (!Object.prototype.hasOwnProperty.call(files, p)) {
                  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
                }
                return files[p];
              },
              async write(p, data) {
                fixture.adapterWrites.push(p);
                if (writeMode === 'fail') throw new Error('INJECTED WRITE ERROR');
                files[p] = writeMode === 'truncate' ? String(data).slice(0, 20) : data;
              },
              async stat(p) {
                if (!Object.prototype.hasOwnProperty.call(files, p)) return null;
                return { type: 'file', ctime: 0, mtime: Date.now(), size: new TextEncoder().encode(files[p]).byteLength };
              },
              async list(folder) {
                return { files: Object.keys(files).filter((f) => f.startsWith(folder + '/')), folders: [] };
              },
              async remove(p) { delete files[p]; },
              async mkdir(p) { fixture.dirs = [...(fixture.dirs || []), p]; },
            } : undefined,
          },
        },
        loadData: async () => {
          fixture.loadCalls++;
          if (fixture.loadFail) throw Error('INJECTED LOAD ERROR');
          return structuredClone(fixture.disk);
        },
        saveData: async (data) => {
          const title = data.database.tasks['task-1']?.title;
          fixture.writes.push(title);
          const delay = fixture.delayByTitle[title] ?? 0;
          if (delay) await new Promise((r) => setTimeout(r, delay));
          if (fixture.saveFail) throw Error('INJECTED SAVE ERROR');
          fixture.disk = structuredClone(data);
        },
      };
    },
    { loadFail, saveFail, invalid, futureSchema, adapter, adapterRaw, pluginDir: PLUGIN_DIR, dataPath: DATA_PATH, writeMode },
  );

  const wantsError = expectError ?? (loadFail || invalid || futureSchema || adapterRaw === 'corrupt');
  if (mount) {
    await page.evaluate(() => tempoAudit.mount(plugin, leaf1));
    await page.locator(wantsError ? '.tempo-error-card' : '.tempo-main-card').waitFor();
    // The fixture has no signed license code, so a licensed session is simulated in memory.
    if (licensed && !wantsError) await grantLicense(page);
  }
  return page;
}

const close = (page) => page.context().close();
const grantLicense = (page) => page.evaluate(() => {
  const s = tempoAudit.store.TempoStore.get(plugin);
  s.data = { ...s.data, licenseStatus: 'valid' };
  s.notify();
});

async function scenario(name, fn) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name)) return;
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS', detail });
    console.log('PASS', name, JSON.stringify(detail));
  } catch (err) {
    results.push({ name, status: 'FAIL', error: String(err.stack || err) });
    console.log('FAIL', name, String(err.message || err).slice(0, 400));
  }
}

const disk = (page) => page.evaluate(() => fixture.disk);
const storeState = (page) => page.evaluate(() => {
  const s = tempoAudit.store.TempoStore.get(plugin);
  return { status: s.status, saveStatus: s.saveStatus, undo: s.undoStack.length, problems: s.loadProblems.length };
});
const files = (page) => page.evaluate(() => fixture.adapterFiles);
const task = (page, name) => page.locator('.tempo-task-row').filter({ hasText: name }).first().click();
const navTo = (page, label) =>
  page.locator('.tempo-sidebar-card .tempo-nav-item').filter({ hasText: label }).first().click();

async function drop(page, id, label) {
  return page.evaluate(({ id, label }) => {
    const el = [...document.querySelectorAll('.tempo-sidebar-card .tempo-nav-item')].find((e) => e.textContent?.includes(label));
    if (!el) throw Error('missing target ' + label);
    const dt = new DataTransfer();
    dt.setData('application/x-tempo-task-id', id);
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, { id, label });
}

const SINGLE_TASK_DB = JSON.stringify({
  schemaVersion: 1, locale: 'zh', defaultDest: 'inbox',
  database: {
    schemaVersion: 1,
    tasks: { t1: { id: 't1', title: 'Original', status: 'todo', triage: 'processed', availability: 'anytime', priority: 'none', createdAt: 1, updatedAt: 1, order: 'a' } },
    projects: {}, cycles: {}, areas: {}, labels: {},
  },
}, null, 2);

// =====================================================================================
// New in round 4 — data safety
// =====================================================================================

await scenario('corrupt_file_is_not_treated_as_first_install', async () => {
  const p = await boot({ adapter: true, adapterRaw: 'corrupt' });
  assert.equal(await p.locator('.tempo-error-card').count(), 1);
  assert.ok((await p.locator('.tempo-error-card').innerText()).includes('无法读取'), 'the reason must be shown');
  assert.equal(await p.locator('.tempo-main-card').count(), 0, 'the app must not open');
  const f = await files(p);
  assert.equal(f[DATA_PATH], '{ "schemaVersion": 1, "database": { "tasks": {', 'corrupt bytes must survive');
  assert.deepEqual(await p.evaluate(() => fixture.adapterWrites), [], 'nothing may be written');
  await close(p);
  return { errorShown: true, originalBytesPreserved: true, writes: 0 };
});

await scenario('genuine_first_install_seeds_and_persists', async () => {
  const p = await boot({ adapter: true, adapterRaw: 'none' });
  assert.equal(await p.locator('.tempo-main-card').count(), 1, 'a real first install must load');
  const seeded = JSON.parse((await files(p))[DATA_PATH]);
  assert.equal(seeded.schemaVersion, 1);
  // A fresh install starts empty on purpose (README: 干净空白初态).
  assert.equal(Object.keys(seeded.database.tasks).length, 0, 'a fresh install must start empty');
  await p.locator('.tempo-header-actions .tempo-btn-primary').click();
  await p.locator('.tempo-window-input-title').fill('Typed by hand');
  await p.locator('.tempo-window-input-title').press('Enter');
  await p.waitForFunction(() => fixture.adapterFiles[Object.keys(fixture.adapterFiles).find((k) => k.endsWith('data.json'))].includes('Typed by hand'));
  await close(p);
  return { seeded: true, persistedAfterEdit: true };
});

await scenario('write_failure_is_visible_and_the_disk_survives', async () => {
  const p = await boot({ adapter: true, adapterRaw: SINGLE_TASK_DB, writeMode: 'fail' });
  await navTo(p, '随时可做');
  await task(p, 'Original');
  await p.locator('.tempo-inspector-title-input').fill('Changed');
  await p.locator('.tempo-inspector-title-input').blur();
  await p.locator('.tempo-save-feedback.is-error').waitFor();
  assert.equal((await storeState(p)).saveStatus, 'error', 'saveStatus must become error');
  assert.ok((await p.locator('.tempo-save-feedback.is-error').innerText()).includes('保存失败'));
  assert.equal(JSON.parse((await files(p))[DATA_PATH]).database.tasks.t1.title, 'Original', 'disk must be untouched');
  await close(p);
  return { errorShown: true, diskUntouched: true };
});

await scenario('retry_after_a_failed_write_persists', async () => {
  const p = await boot({ adapter: true, adapterRaw: SINGLE_TASK_DB, writeMode: 'ok' });
  // Make the adapter fail only until the retry button is pressed.
  await p.evaluate(() => {
    const adapter = plugin.app.vault.adapter;
    window.__okWrite = adapter.write.bind(adapter);
    adapter.write = async () => { throw new Error('INJECTED WRITE ERROR'); };
  });
  await navTo(p, '随时可做');
  await task(p, 'Original');
  await p.locator('.tempo-inspector-title-input').fill('Changed');
  await p.locator('.tempo-inspector-title-input').blur();
  await p.locator('.tempo-save-feedback.is-error').waitFor();
  await p.evaluate(() => { plugin.app.vault.adapter.write = window.__okWrite; });
  await p.getByRole('button', { name: '重试保存' }).click();
  await p.waitForFunction(() => {
    try { return JSON.parse(fixture.adapterFiles[Object.keys(fixture.adapterFiles).find((k) => k.endsWith('data.json'))]).database.tasks.t1.title === 'Changed'; }
    catch { return false; }
  });
  assert.equal((await storeState(p)).saveStatus, 'saved');
  await close(p);
  return { retryPersisted: true };
});

await scenario('truncated_write_is_detected', async () => {
  const p = await boot({ adapter: true, adapterRaw: SINGLE_TASK_DB, writeMode: 'truncate' });
  await navTo(p, '随时可做');
  await task(p, 'Original');
  await p.locator('.tempo-inspector-title-input').fill('Changed');
  await p.locator('.tempo-inspector-title-input').blur();
  await p.locator('.tempo-save-feedback.is-error').waitFor();
  assert.equal((await storeState(p)).saveStatus, 'error', 'a short write must be reported');
  await close(p);
  return { truncatedWriteDetected: true };
});

await scenario('invalid_entries_offer_problem_list_export_and_salvage', async () => {
  const p = await boot({ adapter: true, adapterRaw: 'fixture', invalid: true });
  const card = p.locator('.tempo-error-card');
  const text = await card.innerText();
  assert.ok(text.includes('检测到 1 处数据问题'), 'problem count expected: ' + text);
  assert.ok(text.includes('task:bad'), 'the offending entry must be named: ' + text);
  assert.ok(text.includes('entry is not an object'), 'the reason must be shown: ' + text);

  await card.getByRole('button', { name: '导出原文件' }).click();
  await p.waitForFunction(() => (window.__tempoNotices || []).length > 0);
  const exported = Object.keys(await files(p)).filter((f) => f.startsWith('crisp-tempo-data-'));
  assert.equal(exported.length, 1, 'one export file expected: ' + JSON.stringify(await files(p)));
  const exportedText = (await files(p))[exported[0]];
  assert.ok(exportedText.includes('"bad"'), 'the export must carry the original bytes');
  assert.equal((await p.evaluate(() => window.__tempoNotices))[0].includes(exported[0]), true, 'a notice must name the file');

  await card.getByRole('button', { name: '放弃 1 条损坏项并继续' }).click();
  await card.getByRole('button', { name: '确认放弃并继续' }).click();
  await p.locator('.tempo-main-card').waitFor();
  assert.equal((await storeState(p)).status, 'ready');
  const saved = JSON.parse((await files(p))[DATA_PATH]);
  assert.equal(saved.database.tasks.bad, undefined, 'the broken entry must be gone');
  assert.equal(Object.keys(saved.database.tasks).length, 4, 'healthy entries must remain');
  await close(p);
  return { problemsListed: true, exportWritten: exported[0], salvaged: true };
});

// =====================================================================================
// New in round 4 — interaction
// =====================================================================================

await scenario('selection_is_cleared_when_switching_views', async () => {
  const p = await boot();
  await task(p, 'Primary Task');
  await p.locator('.tempo-inspector-card').waitFor();
  await navTo(p, '收集箱');
  await p.waitForTimeout(150);
  assert.equal(await p.locator('.tempo-inspector-card').count(), 0, 'the inspector must close on a view change');
  assert.equal(await p.locator('.tempo-root.has-selected-task').count(), 0);
  await close(p);
  return { inspectorClosedOnNavChange: true };
});

await scenario('description_commits_on_blur_only', async () => {
  const p = await boot();
  await task(p, 'Primary Task');
  const before = (await storeState(p)).undo;
  const box = p.locator('.tempo-desc-textarea');
  await box.click();
  await box.pressSequentially('hello world');
  await p.waitForTimeout(150);
  assert.equal((await storeState(p)).undo, before, 'typing must not push undo snapshots');
  assert.equal(
    await p.evaluate(() => tempoAudit.store.TempoStore.get(plugin).data.database.tasks['task-1'].description),
    undefined, 'typing must not reach the store',
  );
  await box.blur();
  await p.waitForFunction(() => tempoAudit.store.TempoStore.get(plugin).data.database.tasks['task-1'].description === 'hello world');
  assert.equal((await storeState(p)).undo - before, 1, 'exactly one snapshot for the whole edit');
  await close(p);
  return { snapshotsWhileTyping: 0, snapshotsForCommit: 1 };
});

await scenario('mobile_nav_keeps_focus_across_store_updates', async () => {
  const p = await boot({ width: 390, height: 760, mobile: true, paneWidth: 390 });
  await p.locator('.tempo-projects-entry').click();
  await p.locator('.tempo-mobile-nav-modal').waitFor();
  await p.locator('.tempo-mobile-nav-modal button').nth(3).focus();
  const before = await p.evaluate(() => document.activeElement?.textContent ?? '');
  assert.ok(before.length > 0, 'a control must be focused');
  await p.evaluate(() => tempoAudit.store.TempoStore.get(plugin).notify());
  await p.waitForTimeout(150);
  const after = await p.evaluate(() => document.activeElement?.textContent ?? '');
  assert.equal(after, before, 'focus must survive a store notification');
  await close(p);
  return { focusedBefore: before, focusedAfter: after };
});

// =====================================================================================
// Round-3 regression suite
// =====================================================================================

await scenario('load_errors_preserve_data', async () => {
  const a = await boot({ loadFail: true });
  assert.equal(await a.locator('.tempo-error-card').count(), 1);
  assert.equal(await a.getByRole('button', { name: '重试读取' }).count(), 1);
  assert.equal(await a.evaluate(() => fixture.writes.length), 0);
  await close(a);
  const b = await boot({ invalid: true });
  assert.equal(await b.locator('.tempo-error-card').count(), 1);
  assert.equal((await disk(b)).database.tasks.bad, null, 'the bad entry must not be rewritten away');
  assert.equal(await b.evaluate(() => fixture.writes.length), 0);
  await close(b);
  const c = await boot({ futureSchema: true });
  assert.equal(await c.locator('.tempo-error-card').count(), 1);
  assert.equal(await c.evaluate(() => fixture.writes.length), 0);
  await close(c);
  return { loadFailure: 'error shown', invalidEntry: 'preserved and rejected', futureSchema: 'rejected' };
});

await scenario('save_queue_and_retry', async () => {
  const p = await boot();
  await task(p, 'Primary Task');
  const title = p.locator('.tempo-inspector-title-input');
  await p.evaluate(() => { fixture.delayByTitle.A = 230; });
  await title.fill('A');
  await title.blur();
  await p.waitForFunction(() => fixture.writes.includes('A'));
  await title.fill('B');
  await title.blur();
  await p.waitForFunction(() => fixture.disk.database.tasks['task-1'].title === 'B');
  assert.deepEqual(await p.evaluate(() => fixture.writes.slice(-2)), ['A', 'B']);
  assert.equal((await storeState(p)).saveStatus, 'saved');
  await close(p);
  const q = await boot({ saveFail: true });
  await task(q, 'Primary Task');
  await q.locator('.tempo-inspector-title-input').fill('Retry me');
  await q.locator('.tempo-inspector-title-input').blur();
  await q.locator('.tempo-save-feedback.is-error').waitFor();
  assert.equal((await disk(q)).database.tasks['task-1'].title, 'Primary Task');
  await q.evaluate(() => { fixture.saveFail = false; });
  await q.getByRole('button', { name: '重试保存' }).click();
  await q.waitForFunction(() => fixture.disk.database.tasks['task-1'].title === 'Retry me');
  await close(q);
  return { writes: ['A', 'B'], retry: 'persisted' };
});

await scenario('first_open_quick_add_is_targeted', async () => {
  const p = await boot({ mount: false });
  await p.evaluate(() => { tempoAudit.mount(plugin, leaf1); tempoAudit.store.TempoStore.get(plugin).openQuickAdd(leaf1); });
  await p.locator('#app .tempo-window-card').waitFor();
  assert.equal(await p.locator('#app .tempo-modal-backdrop').count(), 1);
  await p.locator('#app .tempo-window-close-btn').click();
  await p.evaluate(() => {
    document.getElementById('app2').style.display = 'block';
    tempoAudit.mount(plugin, leaf2, 'app2');
    plugin.app.workspace.activeLeaf = leaf2;
    tempoAudit.store.TempoStore.get(plugin).openQuickAdd(leaf2);
  });
  await p.locator('#app2 .tempo-window-card').waitFor();
  assert.equal(await p.locator('#app .tempo-modal-backdrop').count(), 0);
  assert.equal(await p.locator('#app2 .tempo-modal-backdrop').count(), 1);
  await close(p);
  return { firstOpen: true, secondLeafOnly: true };
});

await scenario('shared_views_and_shortcuts', async () => {
  const p = await boot();
  await task(p, 'Primary Task');
  await p.locator('.tempo-inspector-title-input').fill('Shared Title');
  await p.locator('.tempo-inspector-title-input').blur();
  await p.waitForFunction(() => tempoAudit.store.TempoStore.get(plugin).data?.database.tasks['task-1'].title === 'Shared Title');
  await p.evaluate(() => { document.getElementById('app2').style.display = 'block'; tempoAudit.mount(plugin, leaf2, 'app2'); });
  await p.locator('#app2 .tempo-main-card').waitFor();
  assert.equal(await p.evaluate(() => fixture.loadCalls), 1, 'one load for both views');
  await p.locator('#app2 .tempo-task-row').filter({ hasText: 'Shared Title' }).first().click();
  await p.locator('#app2 .tempo-inspector-card').waitFor();
  await p.waitForTimeout(150);
  await p.evaluate(() => { plugin.app.workspace.activeLeaf = leaf2; document.body.focus(); });
  const before = (await storeState(p)).undo;
  await p.keyboard.press('x');
  assert.equal(
    await p.evaluate(() => tempoAudit.store.TempoStore.get(plugin).data?.database.tasks['task-1'].status),
    'done', 'x on the active leaf completes once',
  );
  await p.waitForFunction(() => fixture.disk.database.tasks['task-1'].status === 'done');
  assert.equal((await storeState(p)).undo - before, 1);
  await p.evaluate(() => { document.getElementById('app2').style.display = 'none'; document.body.focus(); });
  await p.keyboard.press('x');
  await p.waitForTimeout(150);
  assert.equal((await disk(p)).database.tasks['task-1'].status, 'done', 'a hidden leaf must not react');
  await close(p);
  return { loads: 1, sharedTitle: true, undoDelta: 1, hiddenLeafIgnored: true };
});

await scenario('drag_transitions_preserve_schedule', async () => {
  const p = await boot();
  await drop(p, 'task-1', '收集箱');
  await p.waitForFunction(() => fixture.disk.database.tasks['task-1'].triage === 'inbox');
  let d = await disk(p);
  assert.equal(d.database.tasks['task-1'].triage, 'inbox');
  assert.ok(d.database.tasks['task-1'].dueDate, 'the due date must survive');
  await drop(p, 'task-3', '接下来');
  assert.equal(await p.getByRole('alert').count(), 1, 'an invalid Upcoming drop must explain itself');
  assert.equal((await disk(p)).database.tasks['task-3'].startDate, undefined);
  await drop(p, 'task-4', '今天');
  await p.waitForFunction(() => fixture.disk.database.tasks['task-4'].status === 'todo');
  assert.equal((await disk(p)).database.tasks['task-4'].completedAt, undefined);
  await drop(p, 'task-2', '今天');
  await p.waitForFunction(() => fixture.disk.database.tasks['task-2'].focusDate);
  await drop(p, 'task-2', '接下来');
  await p.waitForFunction(() => fixture.disk.database.tasks['task-2'].focusDate === undefined);
  assert.ok((await disk(p)).database.tasks['task-2'].dueDate);
  await drop(p, 'task-2', 'Current Cycle');
  await p.waitForFunction(() => fixture.disk.database.tasks['task-2'].cycleId === 'cycle-1');
  await close(p);
  return { duePreserved: true, invalidUpcomingRejected: true, doneReopened: true, cycleAssigned: true };
});

await scenario('inbox_excludes_completed_items', async () => {
  const p = await boot();
  await navTo(p, '收集箱');
  await p.locator('.tempo-main-card').waitFor();
  assert.equal(await p.locator('.tempo-task-row').filter({ hasText: 'Inbox Task' }).count(), 1);
  await p.locator('.tempo-task-row').filter({ hasText: 'Inbox Task' }).locator('.tempo-status-btn').click();
  await p.waitForFunction(() => tempoAudit.store.TempoStore.get(plugin).data.database.tasks['task-2'].status === 'done');
  await p.waitForTimeout(150);
  assert.equal(
    await p.locator('.tempo-task-row').filter({ hasText: 'Inbox Task' }).count(), 0,
    'a completed item must leave the inbox',
  );
  assert.equal(
    await p.evaluate(() => tempoAudit.store.TempoStore.get(plugin).data.database.tasks['task-2'].triage),
    'inbox', 'triage is untouched, only the view filters',
  );
  await close(p);
  return { inboxEmptiedOnComplete: true };
});

await scenario('cycle_defaults_and_required_dates', async () => {
  const p = await boot();
  await p.locator('.tempo-sidebar-add-btn').nth(1).click();
  const values = await p.locator('.tempo-window-card .tempo-datepicker-label').allTextContents();
  const expected = await p.evaluate(() => {
    const end = fixture.disk.database.cycles['cycle-1'].endDate;
    const d = new Date(end + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  assert.equal(values[0], expected);
  assert.equal(await p.locator('.tempo-window-card .tempo-pill-btn.is-active').textContent(), '规划待开始');
  assert.equal(await p.locator('.tempo-window-input-title').inputValue(), '周期 2', 'localised default title');
  await p.locator('.tempo-window-card .tempo-datepicker-clear-btn').first().click();
  await p.locator('.tempo-window-actions .tempo-btn-primary').click();
  assert.equal(await p.locator('.tempo-window-card').count(), 1, 'the modal stays open on error');
  assert.ok((await p.locator('.tempo-window-card').innerText()).includes('不能为空'));
  assert.equal(Object.keys((await disk(p)).database.cycles).length, 1);
  await close(p);
  return { defaultStart: expected, defaultStatus: 'upcoming', defaultTitle: '周期 2', emptyDateRejected: true };
});

await scenario('settings_version_export_and_full_english_ui', async () => {
  const p = await boot();
  await p.locator('.tempo-header-actions').getByRole('button', { name: '设置' }).click();
  await p.locator('.tempo-window-card').waitFor();
  assert.ok((await p.locator('.tempo-about-version').innerText()).startsWith('版本 0.1.0'), 'the real version must be shown');
  assert.equal(await p.locator('.tempo-settings-item-title').filter({ hasText: '导出数据备份' }).count(), 1);

  await p.getByRole('button', { name: 'English' }).click();
  await p.waitForTimeout(200);
  const modalText = (await p.locator('.tempo-window-card').innerText()).replace(/简体中文/g, '');
  assert.ok(!/[\u4e00-\u9fff]/.test(modalText), 'no Chinese may remain in the English settings: ' + modalText);
  await p.getByRole('button', { name: 'Done' }).click();
  await p.waitForTimeout(200);
  const chrome = await p.locator('.tempo-root').innerText();
  assert.ok(!/[\u4e00-\u9fff]/.test(chrome), 'no Chinese may remain in the English UI: ' + chrome);
  await close(p);
  return { versionShown: '版本 0.1.0', exportAvailable: true, englishUiClean: true };
});

await scenario('mobile_navigation_and_date_bounds', async () => {
  const dimensions = [];
  for (const width of [320, 390]) {
    const p = await boot({ width, height: 760, mobile: true, paneWidth: width });
    const entry = p.locator('.tempo-projects-entry');
    assert.equal(await entry.isVisible(), true);
    const er = await entry.boundingBox();
    assert.ok(er.x >= 0 && er.x + er.width <= width);
    const headerBoxes = await p.evaluate(() => ({
      brand: document.querySelector('.tempo-title-group').getBoundingClientRect().toJSON(),
      actions: document.querySelector('.tempo-header-actions').getBoundingClientRect().toJSON(),
    }));
    assert.ok(headerBoxes.brand.bottom <= headerBoxes.actions.top + 1, 'header overlap ' + JSON.stringify(headerBoxes));
    await p.screenshot({ path: out + '/mobile-' + width + '.png' });
    await p.locator('.tempo-header-actions .tempo-btn-primary').click();
    await p.locator('.tempo-window-card .tempo-datepicker-trigger').click();
    const popup = await p.locator('.tempo-datepicker-popover').boundingBox();
    assert.ok(popup.x >= 0 && popup.x + popup.width <= width, 'popover outside ' + width + ': ' + JSON.stringify(popup));
    const dateBody = await p.locator('.tempo-window-body').boundingBox();
    assert.ok(
      popup.y >= dateBody.y - 1 && popup.y + popup.height <= dateBody.y + dateBody.height + 1,
      'popover clipped ' + width + ': ' + JSON.stringify({ popup, dateBody }),
    );
    await p.screenshot({ path: out + '/date-' + width + '.png' });
    await p.keyboard.press('Escape');
    assert.equal(await p.locator('.tempo-datepicker-popover').count(), 0);
    assert.equal(await p.locator('.tempo-window-card').count(), 1);
    await p.keyboard.press('Escape');
    assert.equal(await p.locator('.tempo-window-card').count(), 0);
    await entry.click();
    assert.equal(await p.locator('.tempo-mobile-nav-modal').count(), 1);
    await p.keyboard.press('Escape');
    assert.equal(await p.locator('.tempo-mobile-nav-modal').count(), 0);
    dimensions.push({ width, entryX: er.x, popupX: popup.x, popupRight: popup.x + popup.width });
    await close(p);
  }
  return dimensions;
});

await scenario('pane_layout_and_modal_keyboard', async () => {
  const p = await boot({ width: 1280, height: 900, paneWidth: 600 });
  assert.equal(await p.locator('.tempo-projects-entry').isVisible(), true);
  assert.equal(await p.locator('.tempo-sidebar-card').isVisible(), false);
  const main = await p.locator('.tempo-main-card').boundingBox();
  assert.ok(main.width > 400);
  await p.locator('.tempo-projects-entry').click();
  assert.equal(await p.locator('.tempo-mobile-nav-modal').count(), 1);
  await p.waitForFunction(() => document.querySelector('.tempo-mobile-nav-modal')?.contains(document.activeElement));
  await p.keyboard.press('Shift+Tab');
  assert.equal(
    await p.evaluate(() => document.querySelector('.tempo-mobile-nav-modal').contains(document.activeElement)),
    true,
  );
  await p.keyboard.press('Escape');
  assert.equal(await p.locator('.tempo-mobile-nav-modal').count(), 0);
  await p.locator('.tempo-header-actions .tempo-btn-primary').click();
  await p.locator('.tempo-window-card .tempo-datepicker-trigger').click();
  const data = await p.evaluate(() => {
    const pop = document.querySelector('.tempo-datepicker-popover').getBoundingClientRect();
    const body = document.querySelector('.tempo-window-body').getBoundingClientRect();
    return {
      popup: pop.toJSON(), body: body.toJSON(),
      hit: document.querySelector('.tempo-datepicker-popover').contains(document.elementFromPoint(pop.left + 10, pop.top + 10)),
    };
  });
  assert.ok(data.popup.left >= data.body.left - 1 && data.popup.right <= data.body.right + 1, JSON.stringify(data));
  assert.equal(data.hit, true);
  await close(p);
  return { mainWidth: main.width, dateWithinModal: true };
});

await scenario('midnight_refresh', async () => {
  const p = await boot({ clockTime: '2026-09-28T15:59:59.000Z' });
  const before = await p.locator('.tempo-card-subtitle').first().textContent();
  await p.clock.fastForward(2000);
  await p.waitForTimeout(100);
  const after = await p.locator('.tempo-card-subtitle').first().textContent();
  assert.notEqual(before, after);
  await close(p);
  return { before, after };
});

await scenario('mobile_calendar_quick_action', async () => {
  const p = await boot({ width: 320, height: 760, mobile: true, paneWidth: 320 });
  await p.locator('.tempo-header-actions .tempo-btn-primary').click();
  await p.locator('.tempo-window-card .tempo-datepicker-trigger').click();
  await p.getByRole('button', { name: '明天', exact: true }).click();
  assert.equal(await p.locator('.tempo-datepicker-popover').count(), 0);
  const value = await p.locator('.tempo-window-card .tempo-datepicker-label').textContent();
  assert.match(value, /^\d{4}-\d{2}-\d{2}$/);
  await close(p);
  return { selected: value, footerAccessible: true };
});

// =====================================================================================
// Round 5 — regressions for this round's fixes
// =====================================================================================

const sgDate = (offset) => {
  const d = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(d);
};
const mkTask = (id, title, fields = {}) => ({
  id, title, status: 'todo', triage: 'processed', availability: 'anytime', priority: 'none',
  createdAt: 1, updatedAt: 1, order: id, ...fields,
});
const dbJson = (tasks, extra = {}) => JSON.stringify({
  schemaVersion: 1, locale: 'zh', defaultDest: 'inbox',
  database: { schemaVersion: 1, tasks, projects: {}, cycles: {}, areas: {}, labels: {}, ...extra },
}, null, 2);

await scenario('r5_no_task_is_preselected_on_open', async () => {
  // The fixture contains an entry with id "task-1", the old hardcoded default selection.
  const p = await boot({ width: 390, height: 760, mobile: true, paneWidth: 390 });
  assert.equal(await p.locator('.tempo-inspector-card').count(), 0, 'inspector must stay closed on open');
  await p.locator('.tempo-header-actions .tempo-btn-primary').click({ timeout: 3000 });
  assert.equal(await p.locator('.tempo-window-card').count(), 1, 'header actions stay reachable on a phone');
  await close(p);
  return { inspectorClosed: true, headerReachable: true };
});

await scenario('r5_unfinished_today_items_carry_over', async () => {
  const raw = dbJson({
    carried: mkTask('carried', 'Carried from yesterday', { focusDate: sgDate(-1) }),
    doneYesterday: mkTask('doneYesterday', 'Done yesterday', {
      focusDate: sgDate(-1), status: 'done', completedAt: Date.now() - 86400000,
    }),
    later: mkTask('later', 'Focused tomorrow', { focusDate: sgDate(1) }),
  });
  const p = await boot({ adapter: true, adapterRaw: raw });
  const text = await p.locator('.tempo-main-card').innerText();
  assert.ok(text.includes('Carried from yesterday'), 'an open Today item must carry over');
  assert.ok(!text.includes('Done yesterday'), 'a task finished yesterday leaves Today');
  assert.ok(!text.includes('Focused tomorrow'), 'a future focus date is not today');
  await task(p, 'Carried from yesterday');
  assert.equal(await p.locator('.tempo-property-select').nth(3).inputValue(), 'today', 'inspector agrees');
  await close(p);
  return { carriedOver: true };
});

await scenario('r5_save_strip_does_not_shift_layout', async () => {
  const p = await boot({ adapter: true, adapterRaw: 'fixture' });
  const kpiTop = () => p.evaluate(() => document.querySelector('.tempo-kpi-row').getBoundingClientRect().top);
  const before = await kpiTop();
  await p.locator('.tempo-task-row .tempo-status-btn').first().click();
  const tops = [];
  for (let i = 0; i < 8; i++) { tops.push(await kpiTop()); await p.waitForTimeout(50); }
  assert.ok(tops.every((t) => t === before), 'KPI row moved during a normal save: ' + tops.join(','));
  await p.waitForFunction(() => tempoAudit.store.TempoStore.get(plugin).saveStatus === 'saved');
  await close(p);
  return { kpiTop: before, stable: true };
});

await scenario('r5_slow_save_still_reports_progress', async () => {
  const p = await boot({ adapter: true, adapterRaw: 'fixture' });
  await p.evaluate(() => {
    const a = plugin.app.vault.adapter; const w = a.write.bind(a);
    a.write = async (...args) => { await new Promise((r) => setTimeout(r, 2500)); return w(...args); };
  });
  await p.locator('.tempo-task-row .tempo-status-btn').first().click();
  await p.locator('.tempo-save-feedback').waitFor({ timeout: 4000 });
  await close(p);
  return { slowSaveVisible: true };
});

await scenario('r5_canceled_tasks_and_progress', async () => {
  const raw = dbJson({
    a: mkTask('a', 'Alpha done', { projectId: 'p1', status: 'done', completedAt: 1 }),
    b: mkTask('b', 'Bravo canceled', { projectId: 'p1', status: 'canceled', canceledAt: 1 }),
    c: mkTask('c', 'Charlie open', { projectId: 'p1' }),
  }, { projects: { p1: { id: 'p1', title: 'Proj', status: 'active', priority: 'none', createdAt: 1, updatedAt: 1, order: 'a' } } });
  const p = await boot({ adapter: true, adapterRaw: raw });
  await navTo(p, 'Proj');
  const order = await p.locator('.tempo-main-card .tempo-task-title').allTextContents();
  assert.deepEqual(order, ['Charlie open', 'Alpha done', 'Bravo canceled'], 'open work first');
  assert.ok((await p.locator('.tempo-main-card').innerText()).includes('50%'), 'canceled is out of scope');
  assert.equal(await p.locator('.tempo-sidebar-card .tempo-project-nav-item .tempo-nav-badge').innerText(), '50%');
  assert.equal(await p.locator('.tempo-pill-btn.is-active .tempo-pill-count').innerText(), '1', 'header pill counts open tasks');
  // Checkbox on a canceled task reopens it instead of marking it done.
  await p.locator('.tempo-task-row').filter({ hasText: 'Bravo canceled' }).locator('.tempo-status-btn').click();
  const b = (await p.evaluate(() => tempoAudit.store.TempoStore.get(plugin).data.database.tasks.b));
  assert.equal(b.status, 'todo');
  assert.equal(b.canceledAt, undefined);
  // Canceling from the inspector stamps canceledAt.
  await task(p, 'Charlie open');
  await p.locator('.tempo-property-select').first().selectOption('canceled');
  const c = (await p.evaluate(() => tempoAudit.store.TempoStore.get(plugin).data.database.tasks.c));
  assert.equal(c.status, 'canceled');
  assert.equal(typeof c.canceledAt, 'number');
  await close(p);
  return { order, progress: '50%', reopened: true, canceledAtStamped: true };
});

await scenario('r5_upcoming_sorted_by_date', async () => {
  const raw = dbJson({
    x: mkTask('x', 'Far', { dueDate: sgDate(20) }),
    y: mkTask('y', 'Near', { startDate: sgDate(2) }),
    z: mkTask('z', 'Middle', { dueDate: sgDate(9) }),
  });
  const p = await boot({ adapter: true, adapterRaw: raw });
  await navTo(p, '接下来');
  const order = await p.locator('.tempo-main-card .tempo-task-title').allTextContents();
  assert.deepEqual(order, ['Near', 'Middle', 'Far']);
  await close(p);
  return { order };
});

await scenario('r5_cycle_badge_follows_dates', async () => {
  const raw = dbJson({}, { cycles: {
    old: { id: 'old', title: 'Ended cycle', startDate: sgDate(-20), endDate: sgDate(-10), status: 'current' },
    now: { id: 'now', title: 'Running cycle', startDate: sgDate(-2), endDate: sgDate(4), status: 'upcoming' },
  } });
  const p = await boot({ adapter: true, adapterRaw: raw });
  const items = p.locator('.tempo-sidebar-card .tempo-nav-item');
  assert.equal(await items.filter({ hasText: 'Ended cycle' }).locator('.tempo-nav-badge').count(), 0, 'ended cycle is not NOW');
  assert.equal(await items.filter({ hasText: 'Running cycle' }).locator('.tempo-nav-badge').innerText(), '进行中');
  // A new cycle chains after the running one, not after the stale "current" flag.
  await p.locator('.tempo-sidebar-add-btn').nth(1).click();
  const start = (await p.locator('.tempo-window-card .tempo-datepicker-label').allTextContents())[0];
  assert.equal(start, sgDate(5));
  assert.equal(await p.locator('.tempo-window-card .tempo-pill-btn.is-active').textContent(), '规划待开始');
  await close(p);
  return { endedBadge: false, runningBadge: true, nextStart: start };
});

await scenario('r5_inspector_inbox_to_anytime', async () => {
  const raw = dbJson({ i: mkTask('i', 'Captured', { triage: 'inbox' }) });
  const p = await boot({ adapter: true, adapterRaw: raw });
  await navTo(p, '收集箱');
  await task(p, 'Captured');
  const when = p.locator('.tempo-property-select').nth(3);
  assert.equal(await when.inputValue(), 'inbox');
  await when.selectOption('anytime');
  const i = await p.evaluate(() => tempoAudit.store.TempoStore.get(plugin).data.database.tasks.i);
  assert.equal(i.triage, 'processed');
  await close(p);
  return { triaged: true };
});

await scenario('r5_subtask_can_be_deleted', async () => {
  const raw = dbJson({
    parent: mkTask('parent', 'Parent', { focusDate: sgDate(0) }),
    s1: mkTask('s1', 'Keep me', { parentTaskId: 'parent' }),
    s2: mkTask('s2', 'Remove me', { parentTaskId: 'parent' }),
  });
  const p = await boot({ adapter: true, adapterRaw: raw });
  await task(p, 'Parent');
  const row = p.locator('.tempo-subtask-item').filter({ hasText: 'Remove me' });
  await row.hover();
  await row.locator('.tempo-subtask-delete-btn').click();
  const titles = await p.locator('.tempo-subtask-title').allTextContents();
  assert.deepEqual(titles, ['Keep me']);
  assert.equal(await p.locator('.tempo-inspector-card').count(), 1, 'parent stays open');
  await p.locator('.tempo-subtask-item .tempo-status-btn').first().focus();
  await p.keyboard.press('Enter');
  const s1 = await p.evaluate(() => tempoAudit.store.TempoStore.get(plugin).data.database.tasks.s1);
  assert.equal(s1.status, 'done', 'subtask checkbox is keyboard operable');
  await close(p);
  return { deleted: true, keyboardToggle: true };
});

await scenario('r5_export_rejects_parent_segments', async () => {
  const p = await boot({ adapter: true, adapterRaw: 'fixture' });
  const res = await p.evaluate(async () => {
    const s = tempoAudit.store.TempoStore.get(plugin);
    const out = {};
    try { await s.exportRawData('../outside'); out.escape = 'written'; } catch (e) { out.escape = 'refused'; }
    out.nested = await s.exportRawData('Backups//Tempo/');
    return out;
  });
  assert.equal(res.escape, 'refused');
  assert.match(res.nested, /^Backups\/Tempo\/crisp-tempo-data-\d{8}-\d{6}\.json$/);
  await close(p);
  return res;
});

await scenario('r5_shortcuts_work_after_error_recovery', async () => {
  const p = await boot({ loadFail: true });
  await p.evaluate(() => { fixture.loadFail = false; });
  await p.locator('.tempo-error-card .tempo-btn-primary').click();
  await p.locator('.tempo-main-card').waitFor();
  await grantLicense(p);
  await p.locator('.tempo-main-card').click({ position: { x: 5, y: 5 } });
  await p.keyboard.press('c');
  await p.locator('.tempo-window-card').waitFor({ timeout: 2000 });
  await close(p);
  return { quickAddAfterRecovery: true };
});

// =====================================================================================
// Round 6 — license gate, project/cycle editing, logbook
// =====================================================================================

await scenario('r6_unlicensed_creation_is_locked', async () => {
  const p = await boot({ adapter: true, adapterRaw: 'fixture', licensed: false });
  const before = await p.evaluate(() => Object.keys(tempoAudit.store.TempoStore.get(plugin).data.database.tasks).length);
  assert.equal(await p.locator('.tempo-license-chip').count(), 1, 'header shows the not-activated chip');
  // Header "New task" opens the activation form instead of the task dialog.
  await p.locator('.tempo-header-actions .tempo-btn-primary').click();
  await p.locator('.tempo-window-card').waitFor();
  assert.equal(await p.locator('.tempo-license-input').count(), 1, 'the activation form is shown');
  assert.equal(await p.locator('.tempo-window-textarea').count(), 0, 'the task dialog is not shown');
  assert.ok((await p.locator('.tempo-window-card').innerText()).includes('新建任务、子任务和项目需要激活码'));
  assert.equal(await p.evaluate(() => document.activeElement?.classList.contains('tempo-license-input')), true, 'license field focused');
  assert.ok((await p.evaluate(() => window.__tempoNotices || [])).some((n) => n.includes('尚未激活')));
  await p.keyboard.press('Escape');
  // Keyboard shortcut and the sidebar project button are gated too.
  await p.locator('.tempo-main-card').click({ position: { x: 5, y: 5 } });
  await p.keyboard.press('c');
  await p.locator('.tempo-license-input').waitFor();
  await p.keyboard.press('Escape');
  await p.locator('.tempo-sidebar-add-btn').first().click();
  await p.locator('.tempo-license-input').waitFor();
  await p.keyboard.press('Escape');
  // The store-level handler refuses as well, even if the modal were reached.
  // The Obsidian "Quick Add Task" command path is gated too.
  await p.evaluate(() => tempoAudit.store.TempoStore.get(plugin).openQuickAdd(leaf1));
  await p.locator('.tempo-license-input').waitFor();
  assert.equal(await p.locator('.tempo-window-textarea').count(), 0);
  await p.keyboard.press('Escape');
  // Existing data stays usable: open, complete, edit.
  await task(p, 'Primary Task');
  assert.equal(await p.locator('.tempo-subtask-locked-btn').count(), 1, 'subtask entry is locked');
  assert.equal(await p.locator('.tempo-add-subtask-input').count(), 0);
  await p.locator('.tempo-inspector-title-input').fill('Edited while unlicensed');
  await p.locator('.tempo-inspector-title-input').blur();
  await p.locator('.tempo-task-row').filter({ hasText: 'Edited while unlicensed' }).locator('.tempo-status-btn').click();
  const after = await p.evaluate(() => tempoAudit.store.TempoStore.get(plugin).data.database.tasks['task-1']);
  assert.equal(after.title, 'Edited while unlicensed');
  assert.equal(after.status, 'done');
  const count = await p.evaluate(() => Object.keys(tempoAudit.store.TempoStore.get(plugin).data.database.tasks).length);
  assert.equal(count, before, 'no task may be created without a license');
  // Activating unlocks creation immediately.
  await grantLicense(p);
  await p.keyboard.press('Escape');
  assert.equal(await p.locator('.tempo-license-chip').count(), 0);
  await p.locator('.tempo-header-actions .tempo-btn-primary').click();
  await p.locator('.tempo-window-input-title').fill('Created after activation');
  await p.locator('.tempo-window-input-title').press('Enter');
  const titles = await p.evaluate(() => Object.values(tempoAudit.store.TempoStore.get(plugin).data.database.tasks).map((t) => t.title));
  assert.ok(titles.includes('Created after activation'), 'creation works once licensed');
  await close(p);
  return { chip: true, headerGated: true, keyGated: true, projectGated: true, subtaskGated: true, editsAllowed: true, unlocks: true };
});

await scenario('r6_hand_edited_status_does_not_unlock', async () => {
  const raw = JSON.stringify({ ...JSON.parse(SINGLE_TASK_DB), licenseStatus: 'valid' });
  const p = await boot({ adapter: true, adapterRaw: raw, licensed: false });
  assert.equal(await p.evaluate(() => tempoAudit.store.TempoStore.get(plugin).data.licenseStatus), undefined);
  assert.equal(await p.locator('.tempo-license-chip').count(), 1);
  const forged = JSON.stringify({ ...JSON.parse(SINGLE_TASK_DB), licenseStatus: 'valid', licenseKey: 'eyJwcm9kdWN0IjoiQ3Jpc3AgU3VpdGUifQ.AAAA' });
  const p2 = await boot({ adapter: true, adapterRaw: forged, licensed: false });
  assert.equal(await p2.evaluate(() => tempoAudit.store.TempoStore.get(plugin).data.licenseStatus), 'invalid');
  await close(p); await close(p2);
  return { noKey: 'unlicensed', forgedKey: 'invalid' };
});

await scenario('r6_edit_and_delete_project', async () => {
  const p = await boot({ adapter: true, adapterRaw: 'fixture' });
  await navTo(p, 'Very long sample project');
  await p.locator('.tempo-card-header-btn.is-secondary').click();
  assert.equal(await p.locator('.tempo-window-title').innerText(), '编辑项目');
  await p.locator('.tempo-window-input-title').fill('Renamed project');
  await p.locator('.tempo-color-dot-btn').nth(4).click();
  await p.locator('.tempo-window-actions .tempo-btn-primary').click();
  const proj = await p.evaluate(() => tempoAudit.store.TempoStore.get(plugin).data.database.projects.p1);
  assert.equal(proj.title, 'Renamed project');
  assert.equal(proj.color, '#f59e0b');
  assert.equal(await p.locator('.tempo-card-title').innerText(), 'Renamed project');
  // Delete takes two clicks, keeps the task and unlinks it.
  await p.locator('.tempo-card-header-btn.is-secondary').click();
  const del = p.locator('.tempo-window-footer .tempo-btn-danger-text');
  await del.click();
  assert.ok((await del.innerText()).includes('1 个任务'), await del.innerText());
  await del.click();
  const db = await p.evaluate(() => tempoAudit.store.TempoStore.get(plugin).data.database);
  assert.equal(db.projects.p1, undefined);
  assert.equal(db.tasks['task-1'].projectId, undefined, 'task kept but unlinked');
  assert.equal(await p.locator('.tempo-card-title').first().innerText(), '今天', 'view returns to Today');
  await p.locator('.tempo-main-card').click({ position: { x: 5, y: 5 } });
  await p.keyboard.press('Meta+z');
  const restored = await p.evaluate(() => tempoAudit.store.TempoStore.get(plugin).data.database);
  assert.equal(restored.projects.p1.title, 'Renamed project');
  assert.equal(restored.tasks['task-1'].projectId, 'p1', 'undo relinks');
  await close(p);
  return { renamed: true, recolored: true, deletedKeepingTasks: true, undo: true };
});

await scenario('r6_edit_and_delete_cycle_from_context_menu', async () => {
  const p = await boot({ adapter: true, adapterRaw: 'fixture' });
  await p.evaluate(() => { window.__tempoNotices = []; tempoAudit.store.TempoStore.get(plugin).updateDatabase((db) => ({
    ...db, tasks: { ...db.tasks, 'task-3': { ...db.tasks['task-3'], cycleId: 'cycle-1' } } })); });
  await p.locator('.tempo-sidebar-card .tempo-nav-item').filter({ hasText: 'Current Cycle' }).click({ button: 'right' });
  assert.equal(await p.evaluate(() => window.__tempoMenu?.items[0].title), '编辑');
  await p.evaluate(() => window.__tempoMenu.items[0].fn());
  assert.equal(await p.locator('.tempo-window-title').innerText(), '编辑周期');
  await p.locator('.tempo-window-input-title').fill('Sprint A');
  await p.locator('.tempo-window-actions .tempo-btn-primary').click();
  assert.equal(await p.evaluate(() => tempoAudit.store.TempoStore.get(plugin).data.database.cycles['cycle-1'].title), 'Sprint A');
  await p.locator('.tempo-sidebar-card .tempo-nav-item').filter({ hasText: 'Sprint A' }).click();
  await p.locator('.tempo-card-header-btn.is-secondary').click();
  const del = p.locator('.tempo-window-footer .tempo-btn-danger-text');
  await del.click(); await del.click();
  const db = await p.evaluate(() => tempoAudit.store.TempoStore.get(plugin).data.database);
  assert.equal(db.cycles['cycle-1'], undefined);
  assert.equal(db.tasks['task-3'].cycleId, undefined);
  assert.ok((await p.evaluate(() => window.__tempoNotices)).some((n) => n.includes('Sprint A')));
  await close(p);
  return { contextMenu: true, renamed: true, deleted: true };
});

await scenario('r6_logbook_lists_canceled', async () => {
  const raw = dbJson({
    d: mkTask('d', 'Finished one', { status: 'done', completedAt: 1000 }),
    c: mkTask('c', 'Dropped one', { status: 'canceled', canceledAt: 2000 }),
    o: mkTask('o', 'Still open'),
  });
  const p = await boot({ adapter: true, adapterRaw: raw });
  await navTo(p, '历史完成记录');
  const titles = await p.locator('.tempo-main-card .tempo-task-title').allTextContents();
  assert.deepEqual(titles, ['Dropped one', 'Finished one']);
  assert.equal(await p.locator('.tempo-pill-btn').filter({ hasText: '已完成' }).locator('.tempo-pill-count').innerText(), '2');
  await close(p);
  return { titles };
});

await scenario('no_uncaught_page_errors', async () => {
  assert.deepEqual(pageErrors, [], 'the UI must not throw during any scenario');
  return { pageErrors: pageErrors.length };
});

await browser.close();
const failed = results.filter((r) => r.status === 'FAIL');
console.log('SUMMARY', JSON.stringify({
  total: results.length, passed: results.length - failed.length, failed: failed.map((r) => r.name),
}));
fs.rmSync(out, { recursive: true, force: true });
if (failed.length) process.exitCode = 1;
