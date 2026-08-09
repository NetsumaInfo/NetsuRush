const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHostPower } = require('../core/hostPower.js');

function fixture({ saved = true, cache = { ok: true, clips: 1, timelines: 1, fresh: 0 } } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-host-power-'));
  let stopped = false;
  let killed = false;
  let captures = 0;
  let running = true;
  const pm = {
    GetCurrentProject: async () => ({}),
    SaveProject: async () => saved,
  };
  const resolve = {
    GetProjectManager: async () => pm,
    GetCurrentPage: async () => 'edit',
  };
  const power = createHostPower({
    CONFIG: {},
    dataDir,
    broadcast: () => {},
    resolveMod: {
      resolveStatus: async () => ({ connected: true, project: 'AMV' }),
      getResolve: async () => resolve,
    },
    bridge: { stop: () => { stopped = true; } },
    adobeBridge: { status: async () => ({}) },
    projectSnapshot: { capture: async () => { captures++; return cache; } },
    captureReaders: {},
    isImageRunningFn: async () => running,
    taskkillFn: async () => { killed = true; running = false; return { ok: true }; },
  });
  return {
    power,
    dataDir,
    state: () => ({ stopped, killed, captures }),
    cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }),
  };
}

test('refuses to close Resolve when SaveProject fails', async (t) => {
  const f = fixture({ saved: false });
  t.after(f.cleanup);

  const result = await f.power.close('resolve');

  assert.equal(result.ok, false);
  assert.deepEqual(f.state(), { stopped: false, killed: false, captures: 0 });
  assert.equal(f.power.state().closed, null);
});

test('refuses to close Resolve when the project cache is not verified', async (t) => {
  const f = fixture({ cache: { ok: false, error: 'cache incomplet' } });
  t.after(f.cleanup);

  const result = await f.power.close('resolve');

  assert.equal(result.ok, false);
  assert.match(result.error, /cache incomplet/i);
  assert.deepEqual(f.state(), { stopped: false, killed: false, captures: 1 });
  assert.equal(f.power.state().closed, null);
});

test('closes Resolve only after save and cache verification succeed', async (t) => {
  const f = fixture();
  t.after(f.cleanup);

  const result = await f.power.close('resolve');

  assert.equal(result.ok, true);
  assert.deepEqual(f.state(), { stopped: true, killed: true, captures: 1 });
  assert.equal(f.power.state().closed.project, 'AMV');
});

test('waits for the Resolve process to disappear before publishing the closed state', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-host-close-race-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let processChecks = 0;
  const pm = { GetCurrentProject: async () => ({}), SaveProject: async () => true };
  const power = createHostPower({
    CONFIG: {}, dataDir, broadcast: () => {},
    resolveMod: {
      resolveStatus: async () => ({ connected: true, project: 'AMV' }),
      getResolve: async () => ({ GetProjectManager: async () => pm, GetCurrentPage: async () => 'edit' }),
    },
    bridge: { stop: () => {} }, adobeBridge: { status: async () => ({}) },
    projectSnapshot: { capture: async () => ({ ok: true, clips: 1, timelines: 1, fresh: 0 }) },
    captureReaders: {},
    // 1 = contrôle initial ; 2 = Windows expose encore brièvement Resolve après taskkill ; 3 = arrêté.
    isImageRunningFn: async () => ++processChecks < 3,
    taskkillFn: async () => ({ ok: true }),
    sleepFn: async () => {},
  });

  assert.equal((await power.close('resolve')).ok, true);
  assert.ok(processChecks >= 3);
  await power.reconcile();
  assert.equal(power.state().closed.project, 'AMV');
});

function reopenResolveFixture({ loadSucceeds = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-host-reopen-'));
  const exe = path.join(dataDir, 'Resolve.exe');
  fs.writeFileSync(exe, 'test');
  let running = true;
  let scriptingConnected = true;
  let folder = ['Clients', 'AMV'];
  let currentProject = { GetName: async () => 'AMV' };
  const opened = [];
  const database = { DbType: 'Disk', DbName: 'Local' };
  const pm = {
    GetCurrentProject: async () => currentProject,
    SaveProject: async () => true,
    GetCurrentDatabase: async () => database,
    SetCurrentDatabase: async () => true,
    GetCurrentFolder: async () => folder.length ? folder[folder.length - 1] : 'Project Library',
    GotoParentFolder: async () => {
      if (!folder.length) return false;
      folder.pop();
      return true;
    },
    GotoRootFolder: async () => { folder = []; return true; },
    OpenFolder: async (name) => {
      const expected = ['Clients', 'AMV'][folder.length];
      if (name !== expected) return false;
      folder.push(name);
      opened.push(name);
      return true;
    },
    LoadProject: async (name) => {
      if (!loadSucceeds || name !== 'AMV' || folder.join('/') !== 'Clients/AMV') return null;
      currentProject = { GetName: async () => 'AMV' };
      return currentProject;
    },
  };
  const resolve = {
    GetProjectManager: async () => pm,
    GetCurrentPage: async () => 'color',
    OpenPage: async () => true,
  };
  const power = createHostPower({
    CONFIG: { resolveExe: exe }, dataDir, broadcast: () => {},
    resolveMod: {
      resolveStatus: async () => ({ connected: true, project: currentProject ? 'AMV' : null }),
      getResolve: async () => resolve,
    },
    bridge: { stop: () => {}, connect: async () => ({ connected: running && scriptingConnected }) },
    adobeBridge: { status: async () => ({}) },
    projectSnapshot: { capture: async () => ({ ok: true, clips: 1, timelines: 1, fresh: 0 }) },
    captureReaders: {},
    isImageRunningFn: async () => running,
    taskkillFn: async () => { running = false; currentProject = null; return { ok: true }; },
    spawnFn: () => { running = true; scriptingConnected = true; return { unref() {} }; },
    sleepFn: async () => {},
  });
  return {
    power,
    opened,
    manualOpen: (withScripting = true) => {
      running = true;
      scriptingConnected = withScripting;
      currentProject = { GetName: async () => 'AMV' };
    },
    cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }),
  };
}

test('reopens Resolve in the saved database folder and verifies the project', async (t) => {
  const f = reopenResolveFixture();
  t.after(f.cleanup);

  assert.equal((await f.power.close('resolve')).ok, true);
  const result = await f.power.reopen();

  assert.equal(result.ok, true);
  assert.deepEqual(f.opened.slice(-2), ['Clients', 'AMV']);
  assert.equal(f.power.state().closed, null);
});

test('restarts Resolve and returns to the saved project location', async (t) => {
  const f = reopenResolveFixture();
  t.after(f.cleanup);

  const result = await f.power.restart('resolve');

  assert.equal(result.ok, true);
  assert.equal(result.project, 'AMV');
  assert.deepEqual(f.opened.slice(-2), ['Clients', 'AMV']);
  assert.equal(f.power.state().closed, null);
});

test('keeps Resolve marked closed when the requested project does not open', async (t) => {
  const f = reopenResolveFixture({ loadSucceeds: false });
  t.after(f.cleanup);

  assert.equal((await f.power.close('resolve')).ok, true);
  const result = await f.power.reopen();

  assert.equal(result.ok, false);
  assert.match(result.error, /projet|project/i);
  assert.equal(f.power.state().closed.project, 'AMV');
});

test('reconciles Resolve from the Windows process even when scripting is unavailable', async (t) => {
  const f = reopenResolveFixture();
  t.after(f.cleanup);

  assert.equal((await f.power.close('resolve')).ok, true);
  f.manualOpen(false);
  await f.power.reconcile();

  assert.equal(f.power.state().closed, null);
});

test('repairs the closed state while a reopen operation is still waiting for Resolve', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-host-busy-reconcile-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const exe = path.join(dataDir, 'Resolve.exe');
  fs.writeFileSync(exe, 'test');
  fs.writeFileSync(path.join(dataDir, 'host-power.json'), JSON.stringify({
    host: 'resolve', project: null, page: 'edit', at: Date.now(),
  }));
  let releaseSleep;
  const firstSleep = new Promise((resolve) => { releaseSleep = resolve; });
  let slept = false;
  const power = createHostPower({
    CONFIG: { resolveExe: exe }, dataDir, broadcast: () => {}, resolveMod: {},
    bridge: { connect: async () => ({ connected: true }) },
    adobeBridge: { status: async () => ({}) },
    projectSnapshot: null, captureReaders: null,
    isImageRunningFn: async () => true,
    sleepFn: async () => { if (!slept) { slept = true; await firstSleep; } },
  });

  const reopening = power.reopen();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(power.state().busy, true);
  await power.reconcile();
  assert.equal(power.state().closed, null);
  releaseSleep();
  assert.equal((await reopening).ok, true);
});

for (const app of ['ppro', 'aeft']) {
  test(`reopens ${app} with its saved project and waits for process confirmation`, async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `nr-host-${app}-`));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const projectPath = path.join(dataDir, app === 'ppro' ? 'edit.prproj' : 'motion.aep');
    fs.writeFileSync(projectPath, 'test');
    let running = true;
    let launchedWith = null;
    const power = createHostPower({
      CONFIG: {}, dataDir, broadcast: () => {}, resolveMod: {}, bridge: {},
      adobeBridge: {
        snapshot: () => ({ project: path.basename(projectPath), projectPath }),
        close: async () => { running = false; return { ok: true }; },
        launch: async (_app, file) => { launchedWith = file; running = true; return { ok: true }; },
        status: async () => ({ [app]: { running } }),
      },
      projectSnapshot: null, captureReaders: null,
      sleepFn: async () => {},
    });

    assert.equal((await power.close(app)).ok, true);
    running = true;
    await power.reconcile();
    assert.equal(power.state().closed, null);

    assert.equal((await power.close(app)).ok, true);
    assert.equal((await power.reopen()).ok, true);
    assert.equal(launchedWith, projectPath);
    assert.equal(power.state().closed, null);
  });
}
