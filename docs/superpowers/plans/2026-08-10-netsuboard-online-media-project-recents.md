# NetsuBoard Online Media and Project Recents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make YouTube work in the installed application, support linked or downloaded generic HTML5 video pages, and show saved `.netsu` documents only once in the unified Recent grid.

**Architecture:** Keep the existing YouTube relay and online-media preference, but make NetsuBoard's Python link tools part of the mandatory repaired runtime. Extend the existing generic resolver with a linked/download result and HTML5 `<video>` discovery. Carry internal-scene identity through Save As so the core can record, clean up, and durably de-duplicate converted file projects.

**Tech Stack:** Node.js 22 CommonJS core, React 19 + TypeScript renderer, PowerShell first-run setup, Tauri v2 runtime, Node test runner.

---

## File Map

- `core/setup.js`: setup schema version and mandatory online-media runtime readiness.
- `scripts/setup.ps1`: unconditional NetsuBoard link-tool installation and import probe.
- `python/requirements-reference.txt`: existing `yt-dlp` and `gallery-dl` manifest, kept as the focused Board requirements file.
- `core/ytstream.js`: actionable YouTube resolver logging while preserving the stable relay endpoint.
- `core/reference.js`: generic page parsing and linked/download resolution.
- `core/rpc.js`: forwards the resolver options through the existing IPC channel.
- `src/lib/bridge.ts`: shared resolver, project-save, and recent-entry types plus browser mock.
- `src/lib/coreClient.ts`: renderer implementation of the extended IPC signatures.
- `src/components/reference/useBoardIngest.ts`: applies `autoDownloadOnline` consistently to YouTube, direct video links, named providers, and generic pages.
- `core/netsu.js`: records the converted scene id and deletes the internal scene only after successful file save.
- `core/netsu/recents.js`: persists and preserves the optional source scene id.
- `src/components/reference/useScenePersistence.ts`: sends the current scene id during Save As.
- `src/components/reference/ReferenceHome.tsx`: one Recent section containing session, files, and unconverted scenes.
- `docs/modules.md`: documents the installed-runtime and generic HTML5-page contracts.
- `test/packaging.test.cjs`, `test/setup-selection.test.cjs`: production-runtime regressions.
- `test/ytstream.test.cjs`: resolver diagnostic regression.
- `test/reference-online-media.test.cjs`: real local HTTP linked/download resolver tests.
- `test/reference-online-media-ui.test.cjs`: renderer routing contract.
- `test/netsu-project-recents.test.cjs`: Save As identity and cleanup lifecycle.
- `test/reference-home.test.cjs`: single Recent-section contract.

### Task 1: Make NetsuBoard link tools mandatory in packaged installs

**Files:**
- Modify: `test/packaging.test.cjs`
- Modify: `test/setup-selection.test.cjs`
- Modify: `core/setup.js`
- Modify: `scripts/setup.ps1`

- [ ] **Step 1: Write the failing setup-schema tests**

Add the runtime marker import and regression to `test/setup-selection.test.cjs`:

```js
const { sanitizeSetupOptions, quickSetupReady, SETUP_RUNTIME_VERSION } = require('../core/setup');

test('quick setup rejects installs created before mandatory NetsuBoard link tools', () => {
  const executable = process.execPath;
  const base = {
    setupCompletedAt: new Date().toISOString(),
    python: executable,
    ffmpeg: executable,
    ffprobe: executable,
    ffmpegVersion: '9.0',
    setupModels: [],
  };
  assert.equal(quickSetupReady(base, { ignorePackageGate: true }), false);
  assert.equal(
    quickSetupReady({ ...base, setupRuntimeVersion: SETUP_RUNTIME_VERSION }, { ignorePackageGate: true }),
    true,
  );
});
```

Update the existing successful quick-check fixture to include:

```js
setupRuntimeVersion: SETUP_RUNTIME_VERSION,
```

Extend `test/packaging.test.cjs` with an unconditional-install contract:

```js
test('NetsuBoard link tools are mandatory and verified outside optional module packs', () => {
  const setup = fs.readFileSync(path.join(root, 'scripts', 'setup.ps1'), 'utf8');
  const mandatory = setup.slice(setup.indexOf('$boardReq'), setup.indexOf('$moduleRequirements'));
  assert.match(mandatory, /requirements-reference\.txt/);
  assert.match(mandatory, /pip install -r \$boardReq/);
  assert.match(mandatory, /import yt_dlp, gallery_dl/);
  const optional = setup.slice(setup.indexOf('$moduleRequirements'), setup.indexOf('Progress 72'));
  assert.doesNotMatch(optional, /reference\s*=\s*'requirements-reference\.txt'/);
  assert.doesNotMatch(optional, /reference\s*=\s*'import yt_dlp, gallery_dl'/);
  assert.match(setup, /setupRuntimeVersion\s*=\s*2/);
  const coreSetup = fs.readFileSync(path.join(root, 'core', 'setup.js'), 'utf8');
  assert.match(coreSetup, /import yt_dlp, gallery_dl/);
  assert.match(coreSetup, /runtime\.online/);
});
```

In the existing `first-run setup imports each selected module pack before declaring success` test,
replace the old optional-reference assertion with:

```js
assert.doesNotMatch(probes, /reference\s*=\s*'import yt_dlp, gallery_dl'/);
```

- [ ] **Step 2: Run the setup tests and verify RED**

Run:

```powershell
node --test test/setup-selection.test.cjs test/packaging.test.cjs
```

Expected: FAIL because `SETUP_RUNTIME_VERSION` and the unconditional `$boardReq` block do not exist, and old completed installs still pass the quick check.

- [ ] **Step 3: Add the setup runtime schema and probe**

In `core/setup.js`, add and enforce the marker:

```js
const SETUP_RUNTIME_VERSION = 2;

function quickSetupReady(config = CONFIG, options = {}) {
  if ((!PACKAGED && !options.ignorePackageGate) || !config || !config.setupCompletedAt) return false;
  if (Number(config.setupRuntimeVersion) !== SETUP_RUNTIME_VERSION) return false;
  // existing path, ffmpeg, and optional-model checks remain unchanged
}
```

Add link tools to `probeRuntime` without changing the optional model logic:

```js
'r["online"]=False',
'import yt_dlp, gallery_dl; r["online"]=True',
```

Include `online` in the computed result and setup readiness:

```js
const onlineReady = runtime === true || !!runtime.online;
ready: venv && transnet && ffmpeg && modelsReady && gpuReady && onlineReady,
```

Append this exact element to the existing `items` array returned by `setupStatus`:

```js
{ id: 'online', label: 'NetsuBoard · yt-dlp', done: onlineReady },
```

The quick-ready synthetic runtime must include `online: true`. Export the marker:

```js
SETUP_RUNTIME_VERSION, FFMPEG_ACCEPTED_VERSIONS, ffmpegVersionAccepted,
```

- [ ] **Step 4: Install and verify the Board requirements unconditionally**

In `scripts/setup.ps1`, immediately after `requirements-base.txt` succeeds and before `$moduleRequirements`, add:

```powershell
$boardReq = Join-Path $pyScripts 'requirements-reference.txt'
if (-not (Test-Path $boardReq)) { Fail "pack NetsuBoard introuvable: $boardReq" }
Stage 'deps' "$(T 'depsInstall') · NetsuBoard"
$boardLog = & $venvPy -m pip install -r $boardReq --retries 5 --timeout 120 2>&1
if ($LASTEXITCODE -ne 0) {
  $boardLog | ForEach-Object { Info "pip NetsuBoard> $_" }
  Fail (T 'requirementsFailed')
}
$boardProbe = & $venvPy -c 'import yt_dlp, gallery_dl' 2>&1
if ($LASTEXITCODE -ne 0) {
  $boardProbe | ForEach-Object { Info "probe NetsuBoard> $_" }
  Fail "NetsuBoard est installé mais ses outils de liens sont inutilisables"
}
```

Remove `reference` from `$moduleRequirements` and `$packProbes`. Add this field to the final configuration hashtable:

```powershell
setupRuntimeVersion = 2
```

- [ ] **Step 5: Run the setup tests and verify GREEN**

Run:

```powershell
node --test test/setup-selection.test.cjs test/packaging.test.cjs
```

Expected: PASS, including rejection of an old packaged config and unconditional Board-tool installation/probing.

- [ ] **Step 6: Commit the packaged-runtime fix**

```powershell
git add -- core/setup.js scripts/setup.ps1 test/setup-selection.test.cjs test/packaging.test.cjs
git commit -m "fix: repair NetsuBoard link tools in production"
```

### Task 2: Preserve the YouTube relay and expose its real resolver failure

**Files:**
- Create: `test/ytstream.test.cjs`
- Modify: `core/ytstream.js`

- [ ] **Step 1: Write the failing relay diagnostic test**

Create `test/ytstream.test.cjs`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

test('YouTube relay logs the yt-dlp failure before returning 502', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const originalError = console.error;
  const errors = [];
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      child.stderr.emit('data', Buffer.from("No module named 'yt_dlp'"));
      child.emit('close', 1);
    });
    return child;
  };
  console.error = (...args) => errors.push(args.join(' '));
  delete require.cache[require.resolve('../core/ytstream')];
  const { serveYoutube } = require('../core/ytstream');
  const response = {
    status: 0,
    body: '',
    writeHead(code) { this.status = code; return this; },
    end(body = '') { this.body = String(body); },
  };
  try {
    await serveYoutube({ headers: {} }, response, 'hFldDZZcrQo');
    assert.equal(response.status, 502);
    assert.equal(response.body, 'resolve failed');
    assert.match(errors.join('\n'), /ytstream.*No module named 'yt_dlp'/i);
  } finally {
    childProcess.spawn = originalSpawn;
    console.error = originalError;
    delete require.cache[require.resolve('../core/ytstream')];
  }
});
```

- [ ] **Step 2: Run the relay test and verify RED**

Run:

```powershell
node --test test/ytstream.test.cjs
```

Expected: FAIL because the relay discards the resolver error and only writes the HTTP response.

- [ ] **Step 3: Log sanitized resolver failures at the core boundary**

In `core/ytstream.js`, add:

```js
function logResolveFailure(id, error) {
  const detail = String(error || 'unknown error').replace(/[\r\n]+/g, ' ').slice(0, 800);
  console.error(`ytstream: resolve ${id} failed: ${detail}`);
}
```

Call it for both initial and renewal failures before returning 502:

```js
if (!first.ok || !first.url) {
  logResolveFailure(id, first.error);
  res.writeHead(502).end('resolve failed');
  return;
}
```

Keep the renderer's existing iframe fallback unchanged.

- [ ] **Step 4: Run the relay test and verify GREEN**

Run:

```powershell
node --test test/ytstream.test.cjs
```

Expected: PASS with one captured diagnostic and a 502 response.

- [ ] **Step 5: Commit the relay diagnostic**

```powershell
git add -- core/ytstream.js test/ytstream.test.cjs
git commit -m "fix: expose YouTube relay resolver failures"
```

### Task 3: Resolve generic HTML5 video pages as links or local assets

**Files:**
- Create: `test/reference-online-media.test.cjs`
- Modify: `core/reference.js`
- Modify: `core/rpc.js`
- Modify: `src/lib/bridge.ts`
- Modify: `src/lib/coreClient.ts`

- [ ] **Step 1: Write the failing real-HTTP resolver test**

Create `test/reference-online-media.test.cjs` with a local server, not a mocked parser:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createReferenceStore } = require('../core/reference');

test('generic HTML5 video pages support linked and downloaded media', async (t) => {
  let mediaRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/files/12831/embed') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<video controls><source src="/Video/Full008/sample.mp4" type="video/mp4"></video>');
      return;
    }
    if (req.url === '/Video/Full008/sample.mp4') {
      mediaRequests += 1;
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(Buffer.from('video bytes'));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const page = `http://127.0.0.1:${port}/files/12831/embed`;
  const store = createReferenceStore(fs.mkdtempSync(path.join(os.tmpdir(), 'reference-online-')));

  const linked = await store.resolveMedia(page, { download: false });
  assert.deepEqual(linked, {
    ok: true,
    url: `http://127.0.0.1:${port}/Video/Full008/sample.mp4`,
    kind: 'video',
  });
  assert.equal(mediaRequests, 0, 'linked playback must not copy the video');

  const local = await store.resolveMedia(page, { download: true });
  assert.equal(local.ok, true);
  assert.equal(local.kind, 'video');
  assert.equal(fs.readFileSync(local.path, 'utf8'), 'video bytes');
  assert.equal(mediaRequests, 1);
});
```

- [ ] **Step 2: Run the resolver test and verify RED**

Run:

```powershell
node --test test/reference-online-media.test.cjs
```

Expected: FAIL because the current OpenGraph-only resolver does not recognize `<video><source>` and has no linked result.

- [ ] **Step 3: Add final-URL and HTML5 media parsing**

In `core/reference.js`, make `download` return the final request URL:

```js
res.on('end', () => resolve({
  buf: Buffer.concat(chunks),
  type: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase(),
  finalUrl: u.toString(),
}));
```

Return typed candidates from page parsers:

```js
function absoluteHttpUrl(value, baseUrl) {
  try {
    const url = new URL(decodeEntities(value), baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch (_) { return null; }
}

function parseHtmlVideo(html, baseUrl) {
  const videoTags = html.match(/<video\b[^>]*>/gi) || [];
  const sourceTags = html.match(/<source\b[^>]*>/gi) || [];
  for (const tag of [...videoTags, ...sourceTags]) {
    const type = (tag.match(/type\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (type && !type.toLowerCase().startsWith('video/')) continue;
    const src = (tag.match(/src\s*=\s*["']([^"']+)["']/i) || [])[1];
    const url = src && absoluteHttpUrl(src, baseUrl);
    if (url) return { url, kind: 'video' };
  }
  return null;
}
```

Change `parseOgMedia` to return `{ url, kind }`, with video keys mapped to `video` and image keys mapped to `image`.

Use this complete implementation:

```js
function parseOgMedia(html, baseUrl) {
  const meta = parseMetaTags(html);
  const candidates = [
    ...['og:video:secure_url', 'og:video:url', 'og:video', 'twitter:player:stream']
      .map((key) => ({ key, kind: 'video' })),
    ...['og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src']
      .map((key) => ({ key, kind: 'image' })),
  ];
  for (const candidate of candidates) {
    if (!meta[candidate.key]) continue;
    const url = absoluteHttpUrl(meta[candidate.key], baseUrl);
    if (url) return { url, kind: candidate.kind };
  }
  return null;
}
```

- [ ] **Step 4: Add linked/download resolver results**

Change the store method to:

```js
async function resolveMedia(url, options = {}) {
  try {
    if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'URL invalide' };
    const first = await download(url);
    const downloadMedia = options.download !== false;
    const directKind = first.type.startsWith('video/') ? 'video'
      : first.type.startsWith('image/') ? 'image' : null;
    if (directKind) {
      if (!downloadMedia) return { ok: true, url: first.finalUrl, kind: directKind };
      return persistDownloaded(first, first.finalUrl);
    }
    if (!first.type || first.type.includes('html') || first.type.includes('xml')) {
      const html = first.buf.toString('utf8');
      const media = parseOgMedia(html, first.finalUrl) || parseHtmlVideo(html, first.finalUrl);
      if (media) {
        if (!downloadMedia) return { ok: true, url: media.url, kind: media.kind };
        return fetchAsset(media.url);
      }
    }
    return { ok: false, error: t('noMediaDetected') };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
```

Extract the current direct-byte persistence into `persistDownloaded` so the direct and page branches do not duplicate extension/kind logic.

Add it inside `createReferenceStore`, next to `fetchAsset`:

```js
function persistDownloaded(downloaded, sourceUrl) {
  const type = String(downloaded.type || '');
  let ext = MIME_EXT[type];
  if (!ext) {
    const candidate = (new URL(sourceUrl).pathname.split('.').pop() || '').toLowerCase();
    if (EXT_OK.has(candidate)) ext = candidate;
  }
  if (!ext) return { ok: false, error: t('unsupportedType') + ': ' + type };
  const saved = saveAsset(downloaded.buf, ext);
  if (!saved.ok) return saved;
  return {
    ok: true,
    path: saved.path,
    kind: type.startsWith('video/') || VIDEO_EXTS.has(ext) ? 'video' : 'image',
  };
}
```

Make `fetchAsset` call `persistDownloaded(await download(url), url)` after URL validation.

- [ ] **Step 5: Extend the existing IPC contract in all three required places**

In `core/rpc.js`:

```js
"reference:resolveMedia": ([url, options]) => refStore.resolveMedia(url, options || {}),
```

In `src/lib/bridge.ts`:

```ts
export interface ResolvedOnlineMedia {
  ok: boolean;
  path?: string;
  url?: string;
  kind?: "image" | "video";
  error?: string;
}

resolveMedia(url: string, options?: { download?: boolean }): Promise<ResolvedOnlineMedia>;
```

Keep the browser mock inert but signature-compatible:

```ts
resolveMedia: async (_url, _options) => ({ ok: false, error: "mock" }),
```

In `src/lib/coreClient.ts`:

```ts
resolveMedia: (url, options) => call("reference:resolveMedia", [url, options || {}]),
```

- [ ] **Step 6: Run the resolver test and type-check the core**

Run:

```powershell
node --test test/reference-online-media.test.cjs
npm run check:core
```

Expected: both commands PASS; linked mode makes zero media requests and download mode writes one asset.

- [ ] **Step 7: Commit the generic resolver**

```powershell
git add -- core/reference.js core/rpc.js src/lib/bridge.ts src/lib/coreClient.ts test/reference-online-media.test.cjs
git commit -m "feat: resolve linked HTML5 video pages"
```

### Task 4: Apply the online-media preference consistently in the renderer

**Files:**
- Create: `test/reference-online-media-ui.test.cjs`
- Modify: `src/components/reference/useBoardIngest.ts`

- [ ] **Step 1: Write the failing renderer contract test**

Create `test/reference-online-media-ui.test.cjs`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'reference', 'useBoardIngest.ts'), 'utf8');

test('online ingestion passes the global linked/download choice to the generic resolver', () => {
  assert.match(source, /resolveMedia\(url,\s*\{\s*download:\s*useBoard\.getState\(\)\.prefs\.autoDownloadOnline\s*\}\)/);
  assert.match(source, /res\.path\s*\?\?\s*res\.url/);
});

test('YouTube downloads only in automatic mode and AMVNews stays generic', () => {
  assert.match(source, /if\s*\(yt\s*&&\s*!prefs\.autoDownloadOnline\)/);
  assert.match(source, /if\s*\(yt\s*&&\s*prefs\.autoDownloadOnline\)/);
  assert.doesNotMatch(source, /amvnews/i);
});
```

- [ ] **Step 2: Run the renderer contract test and verify RED**

Run:

```powershell
node --test test/reference-online-media-ui.test.cjs
```

Expected: FAIL because the resolver has no mode argument and YouTube always becomes a linked item.

- [ ] **Step 3: Make resolver placement accept either locator**

Update `resolvePageAndPlace` in `useBoardIngest.ts`:

```ts
const res = await nr.reference.resolveMedia(url, {
  download: useBoard.getState().prefs.autoDownloadOnline,
});
const locator = res.path ?? res.url;
if (res.ok && locator && res.kind) {
  await placeExtracted([{ path: locator, kind: res.kind }], url, at);
  return true;
}
```

`placeExtracted` already persists the page as `sourceUrl`; retain that behaviour for local and remote locators.

- [ ] **Step 4: Route YouTube and named providers through the preference**

At the start of `addUrl`, read the current preferences:

```ts
const prefs = useBoard.getState().prefs;
```

For YouTube, preserve linked playback when automatic download is off. When it is on, show the existing loading item, call `extractAndPlace`, and fall back to the linked YouTube item if extraction fails:

```ts
if (yt && !prefs.autoDownloadOnline) {
  place("youtube", yt, yt, { w: 480, h: 270 }, "YouTube");
  return true;
}
if (yt && prefs.autoDownloadOnline) {
  const at = centerPoint();
  const loadingId = addLoading(at, "YouTube");
  try {
    if (await extractAndPlace(text, at)) return true;
    place("youtube", yt, yt, { w: 480, h: 270 }, "YouTube", at);
    return true;
  } finally {
    removeItem(loadingId);
  }
}
```

For named iframe providers, keep the player if automatic download is off or that provider is not selected:

```ts
const shouldDownloadProvider = !!e
  && prefs.autoDownloadOnline
  && prefs.autoDownloadProviders.includes(e.provider);
if (e && EMBED_PLAYER_PROVIDERS.has(e.provider) && !shouldDownloadProvider) {
  place("embed", e.pageUrl, e.embedUrl, e.size ?? { w: 480, h: 270 }, e.provider);
  return true;
}
```

Generic pages follow only `autoDownloadOnline`; do not add an AMVNews provider, chip, branch, or locale key.

- [ ] **Step 5: Keep direct remote videos linked when automatic download is off**

Before `fetchAsset` in `addRemoteMedia`, add:

```ts
if ((hint === "video" || isVideoUrl(url)) && !useBoard.getState().prefs.autoDownloadOnline) {
  await addVideoFileUrl(url, at);
  return true;
}
```

Images retain their current persistence behaviour.

- [ ] **Step 6: Run renderer tests and build**

Run:

```powershell
node --test test/reference-online-media-ui.test.cjs test/reference-online-media.test.cjs
npm run build
```

Expected: PASS; TypeScript confirms the new resolver union and all callback dependencies are complete.

- [ ] **Step 7: Commit preference-aware ingestion**

```powershell
git add -- src/components/reference/useBoardIngest.ts test/reference-online-media-ui.test.cjs
git commit -m "feat: honor linked media preference on import"
```

### Task 5: Convert saved scenes into one durable file recent

**Files:**
- Create: `test/netsu-project-recents.test.cjs`
- Modify: `core/netsu.js`
- Modify: `core/netsu/recents.js`
- Modify: `src/lib/bridge.ts`
- Modify: `src/components/reference/useScenePersistence.ts`

- [ ] **Step 1: Write the failing project lifecycle tests**

Create `test/netsu-project-recents.test.cjs`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'netsu-recents-'));
process.env.NR_HOME = home;
const { createReferenceStore } = require('../core/reference');
const netsu = require('../core/netsu');

test.after(() => netsu.closeAllProjects());

test('Save As removes the internal source only after saving and remembers its identity', async () => {
  const refStore = createReferenceStore(home);
  const source = refStore.saveScene({ name: 'Projet', items: [], view: null });
  const destPath = path.join(home, 'Projet.netsu');
  const result = await netsu.saveProjectAs(refStore, {
    scene: { name: 'Projet', items: [], view: null },
    destPath,
    sourceSceneId: source.id,
  });
  assert.equal(result.ok, true);
  assert.equal(refStore.loadScene(source.id), null);
  assert.equal(netsu.recentProjects('board').length, 1);
  assert.equal(netsu.recentProjects('board')[0].sourceSceneId, source.id);
  const opened = netsu.openProject(refStore, destPath);
  assert.equal((await opened).readonly, false);
  assert.equal(netsu.recentProjects('board')[0].sourceSceneId, source.id);
});

test('failed Save As leaves the internal source untouched', async () => {
  const refStore = createReferenceStore(fs.mkdtempSync(path.join(os.tmpdir(), 'netsu-recents-fail-')));
  const source = refStore.saveScene({ name: 'À garder', items: [], view: null });
  const result = await netsu.saveProjectAs(refStore, {
    scene: { name: 'À garder', items: [], view: null },
    destPath: '',
    sourceSceneId: source.id,
  });
  assert.equal(result.ok, false);
  assert.notEqual(refStore.loadScene(source.id), null);
});
```

- [ ] **Step 2: Run the project lifecycle tests and verify RED**

Run:

```powershell
node --test test/netsu-project-recents.test.cjs
```

Expected: FAIL because `sourceSceneId` is neither stored nor cleaned up.

- [ ] **Step 3: Preserve source-scene identity in recents**

In `core/netsu/recents.js`, return the optional id from `list`:

```js
sourceSceneId: typeof entry.sourceSceneId === 'string' ? entry.sourceSceneId : undefined,
```

In `remember`, preserve a previous mapping when later opens/saves refresh the same path:

```js
const all = readAll();
const previous = all.find((e) => e && typeof e.path === 'string' && keyFor(e.path) === key);
const kept = all.filter((e) => e && typeof e.path === 'string' && keyFor(e.path) !== key);
const sourceSceneId = typeof entry.sourceSceneId === 'string'
  ? entry.sourceSceneId
  : typeof previous?.sourceSceneId === 'string' ? previous.sourceSceneId : undefined;
```

Store `sourceSceneId` on the new entry only when defined.

- [ ] **Step 4: Clean up the internal scene after successful file save**

Change `core/netsu.js`:

```js
async function saveProjectAs(refStore, { scene, destPath, fromPath, sourceSceneId }) {
  // existing destination creation and save stay unchanged
  recents.remember({
    path: session.path,
    title: (scene && scene.name) || '',
    type: 'board',
    sourceSceneId: typeof sourceSceneId === 'string' ? sourceSceneId : undefined,
  });
  const sourceCleanup = typeof sourceSceneId === 'string'
    ? refStore.deleteScene(sourceSceneId)
    : { ok: true };
  return {
    ...res,
    sidecarDir: sidecar.sidecarDirFor(session.path),
    sourceSceneId,
    sourceCleanup,
  };
}
```

Do not call `deleteScene` on destination failure or cancellation.

- [ ] **Step 5: Extend types and send the current scene id**

In `src/lib/bridge.ts`:

```ts
export interface NetsuProjectSave {
  // existing fields
  sourceSceneId?: string;
  sourceCleanup?: { ok: boolean; error?: string };
}

export interface NetsuRecent {
  // existing fields
  sourceSceneId?: string;
}

saveProjectAs(opts: {
  scene: NetsuScene;
  destPath: string;
  fromPath?: string | null;
  sourceSceneId?: string | null;
}): Promise<NetsuProjectSave>;
```

In `useScenePersistence.ts`, pass the scene id captured before save:

```ts
const res = await api?.saveProjectAs({
  scene: { name: st.sceneName, items: persistable(st.items), view: st.view },
  destPath: dest,
  fromPath: st.filePath,
  sourceSceneId: st.sceneId,
});
```

Keep `sceneId: null` after success.

- [ ] **Step 6: Run project tests and verify GREEN**

Run:

```powershell
node --test test/netsu-project-recents.test.cjs test/netsu-project.test.cjs
```

Expected: PASS; successful Save As leaves one file recent and failed Save As keeps the internal scene.

- [ ] **Step 7: Commit project identity conversion**

```powershell
git add -- core/netsu.js core/netsu/recents.js src/lib/bridge.ts src/components/reference/useScenePersistence.ts test/netsu-project-recents.test.cjs
git commit -m "fix: preserve NetsuBoard project identity on save"
```

### Task 6: Merge file projects into the single Recent grid

**Files:**
- Create: `test/reference-home.test.cjs`
- Modify: `src/components/reference/ReferenceHome.tsx`

- [ ] **Step 1: Write the failing home contract test**

Create `test/reference-home.test.cjs`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'reference', 'ReferenceHome.tsx'), 'utf8');

test('NetsuBoard home renders projects only inside one Recent section', () => {
  assert.doesNotMatch(source, /t\("home\.projects"\)/);
  assert.equal((source.match(/t\("home\.recent"\)/g) || []).length, 1);
  const recentSection = source.slice(source.indexOf('{t("home.recent")}'));
  assert.match(recentSection, /projects\.map\(\(entry\)\s*=>/);
  assert.match(recentSection, /<ProjectCard/);
});

test('file-backed source scenes are filtered from internal recents', () => {
  assert.match(source, /projectSceneIds/);
  assert.match(source, /!projectSceneIds\.has\(s\.id\)/);
});
```

- [ ] **Step 2: Run the home test and verify RED**

Run:

```powershell
node --test test/reference-home.test.cjs
```

Expected: FAIL because the source still renders separate Projects and Recent sections.

- [ ] **Step 3: Compute unconverted scenes**

In `ReferenceHome.tsx`, replace the current visible calculation with:

```ts
const projectSceneIds = new Set(
  projects.map((entry) => entry.sourceSceneId).filter((id): id is string => !!id),
);
const visible = recent.filter((scene) => !hidden.has(scene.id) && !projectSceneIds.has(scene.id));
```

- [ ] **Step 4: Remove the Projects row and render its cards inside Recent**

Delete the separate block headed by `home.projects`. Change the Recent condition to:

```tsx
{(hasSession || projects.length > 0 || visible.length > 0) && (
```

Inside the existing Recent grid, after the session card and before internal scene cards, render:

```tsx
{onOpenRecent && projects.map((entry) => (
  <ProjectCard
    key={entry.path}
    entry={entry}
    onOpen={() => onOpenRecent(entry.path)}
    onForget={() => void forgetProject(entry.path)}
  />
))}
```

Update the file header comment to describe one Recent grid. Do not add a replacement heading or extra explanatory copy.

- [ ] **Step 5: Run the home test and renderer build**

Run:

```powershell
node --test test/reference-home.test.cjs
npm run build
```

Expected: PASS with one Recent label and no Projects label.

- [ ] **Step 6: Commit the unified home grid**

```powershell
git add -- src/components/reference/ReferenceHome.tsx test/reference-home.test.cjs
git commit -m "fix: unify NetsuBoard recent projects"
```

### Task 7: Document and verify the complete change

**Files:**
- Modify: `docs/modules.md`

- [ ] **Step 1: Update the NetsuBoard module contract**

Add two concise points to `docs/modules.md`:

```markdown
- Packaged NetsuBoard always provisions and verifies `yt-dlp` plus `gallery-dl`; they are Board runtime requirements, not optional module dependencies. A runtime-schema bump sends older incomplete installs through the normal repair flow.
- Generic HTML pages exposing OpenGraph media or HTML5 `<video>`/`<source>` can stay linked or be downloaded according to the Board preference. They remain generic pages and do not become named settings providers.
```

Update the `.netsu` project paragraph to state that Save As records the converted internal scene id and the home screen shows the resulting file only in the unified Recent grid.

- [ ] **Step 2: Run focused regression suites**

Run:

```powershell
node --test test/setup-selection.test.cjs test/packaging.test.cjs test/ytstream.test.cjs test/reference-online-media.test.cjs test/reference-online-media-ui.test.cjs test/netsu-project-recents.test.cjs test/netsu-project.test.cjs test/reference-home.test.cjs
```

Expected: all focused tests PASS with zero failures.

- [ ] **Step 3: Run repository checks separately**

Run:

```powershell
npm run check:core
npm run check:i18n
npm run build
node --test test/*.test.cjs
```

Expected: `check:core`, `check:i18n`, and `build` exit 0; all Node suites pass. If a pre-existing unrelated failure occurs, record its exact suite and output instead of merging it into the feature status.

- [ ] **Step 4: Audit scope and generated artifacts**

Run:

```powershell
git diff --check
git status --short
git diff --stat main...HEAD
rg -n -i "amvnews" src core scripts python test docs/modules.md
```

Expected: no whitespace errors, only planned source/test/docs changes, no `dist/` or runtime artifacts, and no AMVNews-specific production branch, provider, setting, or locale entry. The test fixture may describe the generic AMV-style route without naming a production provider.

- [ ] **Step 5: Commit documentation and final corrections**

```powershell
git add -- docs/modules.md
git commit -m "docs: document NetsuBoard online media runtime"
```

- [ ] **Step 6: Record runtime verification boundary**

Do not restart, close, or rebuild the running Tauri application. Report that `core/**` and setup changes require a Tauri window restart, the repair setup must run in an updated installed build, and real YouTube plus generic HTML5 playback remain not verified in the packaged application until that happens.
