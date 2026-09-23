// @ts-check
// core/ytdlpUpdate.js
// yt-dlp is the only runtime dependency that ROTS. ffmpeg, the GLSL shaders and the model weights
// keep working for years; yt-dlp's extractors are broken by the platforms themselves every few
// weeks. It is installed once, by `scripts/setup.ps1`, from the pinned `requirements-reference.txt`
// — after that nothing ever touches it, so an install left alone slowly loses the half of a
// reference board that arrives through a link, and the only cure was a full runtime repair.
//
// The automatic refresh is anchored to the APPLICATION update rather than to a timer or to every
// launch: a build that has just replaced itself is the one moment where new code is already
// expected, and it caps the cost at one upgrade attempt per release. The version that was checked
// is written to nr.config.json, so a boot of the same build does nothing at all.
//
// That anchor has one hole: an installation nobody updates for months also stops refreshing yt-dlp,
// which is exactly when its extractors rot. `ytDlpStatus()` and `updateYtDlpNow()` open the second
// door — Settings › Updates shows the installed version against the one PyPI publishes, and updates
// the library on its own, without waiting for the next application release.
//
// The pin in `requirements-reference.txt` stays the FLOOR for a fresh install and for a repair;
// this only carries an existing venv forward. pip's default upgrade strategy is `only-if-needed`,
// so the torch/CUDA stack of the same venv is not dragged along.
// NetsuBoard runs the same policy on a different mechanism: it provisions the standalone binary and
// calls `yt-dlp -U`, which is refused on a pip install.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFile } = require('node:child_process');
const { CONFIG, DETECT_ENV, saveConfig } = require('./config');
const { t } = require('./i18n');

// A wheel download on a metered connection must never hold the boot, and a machine behind a proxy
// that swallows the request must not hang a process either.
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;
// `python -m yt_dlp --version` pays a full import of the library before printing its one line.
const VERSION_TIMEOUT_MS = 60 * 1000;
// The published-version probe is cosmetic: it must never make the panel wait.
const PROBE_TIMEOUT_MS = 8 * 1000;

// PyPI, not GitHub: pip is what installs the package here, so the release that matters is the one
// pip would actually fetch.
const PYPI_URL = 'https://pypi.org/pypi/yt-dlp/json';

// Same target as `core/extract.js`: the local venv first (dev, where `python` on PATH is not
// necessarily the venv), then the configured interpreter.
function venvPython() {
  const venv = process.platform === 'win32'
    ? path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')
    : path.join(__dirname, '..', '.venv', 'bin', 'python');
  try { if (fs.existsSync(venv)) return venv; } catch (_) {}
  return CONFIG.python || null;
}

/** Application version: the repository package.json in dev, the staged one in a bundle. */
function appVersion() {
  const roots = [process.env.NR_RESOURCE_DIR, path.join(__dirname, '..')].filter(Boolean);
  for (const root of roots) {
    try { return String(JSON.parse(fs.readFileSync(path.join(String(root), 'package.json'), 'utf8')).version || ''); }
    catch (_) { /* next candidate */ }
  }
  return '';
}

/** One child process, never throwing: every caller here reads a failure as "unknown", not a crash. */
function run(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, env: DETECT_ENV, windowsHide: true },
      (error, stdout, stderr) => resolve({ error, out: `${stdout || ''}${stderr || ''}`.trim() }));
  });
}

/** pip install: the one command here that can change what is on disk. */
function upgrade(python) {
  return run(python, ['-m', 'pip', 'install', '--upgrade', 'yt-dlp[default,curl-cffi]'], UPDATE_TIMEOUT_MS);
}

// yt-dlp spells its date version zero-padded (2026.08.19) while a registry normalises the same
// release to 2026.8.19. Two spellings of ONE version: comparing the raw strings claimed an update was
// available against the build already installed. Everything below is canonicalised before it is
// compared or shown, so the panel can never display two versions that are the same release.
function canonicalVersion(value) {
  const text = String(value || '').trim();
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(.*)$/.exec(text);
  return match ? `${match[1]}.${match[2].padStart(2, '0')}.${match[3].padStart(2, '0')}${match[4]}` : text;
}

/**
 * Is `version` strictly OLDER than `latest`? An ORDER, not an inequality: a nightly carries a fourth
 * timestamp segment (2026.08.30.232658) and is newer than the latest stable (2026.08.19), which a
 * plain `!==` read as "an update is available" and offered to downgrade. A segment that is not a
 * number stops the comparison and answers NO: an update is never invented out of a version this
 * cannot read.
 */
function isOlder(version, latest) {
  const left = String(version || '').split('.');
  const right = String(latest || '').split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i] === undefined ? 0 : Number(left[i]);
    const b = right[i] === undefined ? 0 : Number(right[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (a !== b) return a < b;
  }
  return false;
}

// yt-dlp versions are dates (2026.07.04), sometimes with a build suffix. Anything else on the line
// is a warning the module printed on its way up, so the shape is matched rather than the position.
const VERSION_RE = /\b(\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?(?:[.-]\w+)?)\b/;

/**
 * Version installed in the venv, or null when yt-dlp is absent or unusable there.
 * @returns {Promise<string|null>}
 */
async function installedVersion(python) {
  const target = python || venvPython();
  if (!target) return null;
  const { error, out } = await run(target, ['-m', 'yt_dlp', '--version'], VERSION_TIMEOUT_MS);
  if (error && !out) return null;
  const match = VERSION_RE.exec(out);
  return match ? canonicalVersion(match[1]) : null;
}

/**
 * Version PyPI currently publishes, or null. Fails soft on every count — no network, a proxy, a
 * rate limit or a changed payload all mean "unknown", never an error the panel has to show.
 * @returns {Promise<string|null>}
 */
function publishedVersion() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let request;
    try {
      request = https.get(PYPI_URL, { headers: { accept: 'application/json' }, timeout: PROBE_TIMEOUT_MS }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return done(null); }
        let body = '';
        res.setEncoding('utf8');
        // A redirect or an error page can be arbitrarily large; the payload we want is a few KB.
        res.on('data', (chunk) => { body += chunk; if (body.length > 2 * 1024 * 1024) { res.destroy(); done(null); } });
        res.on('end', () => {
          try { done(canonicalVersion(JSON.parse(body)?.info?.version) || null); }
          catch (_) { done(null); }
        });
        res.on('error', () => done(null));
      });
    } catch (_) { return done(null); }
    request.on('timeout', () => { request.destroy(); done(null); });
    request.on('error', () => done(null));
  });
}

/**
 * Upgrades yt-dlp once per application version. Never throws and never blocks: a failure leaves the
 * marker unwritten, so the next boot simply tries again — which is what carries the refresh over
 * for someone who was offline the day they updated.
 * @returns {Promise<{ updated: boolean, reason?: string, version?: string }>}
 */
async function refreshYtDlpForAppVersion() {
  const version = appVersion();
  if (!version) return { updated: false, reason: 'unknown version' };
  if (CONFIG.ytDlpCheckedFor === version) return { updated: false, reason: 'already checked' };

  // A bare `python` from PATH is never used here: `venvPython()` falls back to `CONFIG.python`,
  // written by the setup, and to nothing else. An interpreter the user happens to have on their
  // PATH is not this product's environment to upgrade.
  const python = venvPython();
  if (!python) return { updated: false, reason: 'venv missing' };

  const result = await upgrade(python);
  if (result.error) {
    console.warn(`yt-dlp: update failed (${String(result.error.message || result.error)})`);
    return { updated: false, reason: 'failed' };
  }
  // The boot path deliberately spawns nothing else: reading the version back would double the cost
  // of a refresh that runs while the application is starting. The panel reads it on demand instead.
  saveConfig({ ytDlpCheckedFor: version, ytDlpCheckedAt: Date.now() });
  // pip prints either "Requirement already satisfied" or the version it installed; both mean the
  // venv is now current for this application version, so the marker is written in either case.
  const line = (result.out.split(/\r?\n/).filter((l) => /yt-dlp/i.test(l)).pop() || 'up to date').trim();
  console.log(`yt-dlp: ${line}`);
  return { updated: true, version };
}

/**
 * Read-only snapshot for Settings › Updates. Spawns `--version` (local, cheap) and, unless asked not
 * to, probes PyPI. Installs nothing.
 * @param {{ remote?: boolean }} [options]
 * @returns {Promise<{ ok: true, available: boolean, manager: 'pip', owned: boolean, version: string|null, latest: string|null, outdated: boolean, checkedFor: string|null, checkedAt: number|null, appVersion: string, reason?: string }>}
 */
async function ytDlpStatus(options = {}) {
  const python = venvPython();
  const base = {
    /** @type {true} */ ok: true,
    /** @type {'pip'} */ manager: 'pip',
    // The venv is this product's own environment, so an install found there is always ours to
    // upgrade. NetsuBoard carries the same field for a yt-dlp it did NOT provision.
    owned: python != null,
    checkedFor: CONFIG.ytDlpCheckedFor || null,
    checkedAt: CONFIG.ytDlpCheckedAt || null,
    appVersion: appVersion(),
  };
  if (!python) return { ...base, available: false, version: null, latest: null, outdated: false, reason: 'venv missing' };

  const [version, latest] = await Promise.all([
    installedVersion(python),
    options.remote === false ? Promise.resolve(null) : publishedVersion(),
  ]);
  const outdated = Boolean(version && latest && isOlder(version, latest));
  return { ...base, available: version != null, version, latest, outdated, ...(version ? {} : { reason: 'yt-dlp missing' }) };
}

/**
 * Manual update from Settings › Updates. Bypasses the per-release marker — it IS the answer to an
 * installation that has not seen an application update in months — and reports what changed, so the
 * panel can say "already current" rather than leaving the click without an outcome.
 * @returns {Promise<{ ok: boolean, version: string|null, previous: string|null, changed: boolean, error?: string }>}
 */
async function updateYtDlpNow() {
  const python = venvPython();
  if (!python) return { ok: false, version: null, previous: null, changed: false, error: t('pythonEnvMissing') };

  const previous = await installedVersion(python);
  const result = await upgrade(python);
  if (result.error) {
    const detail = result.out.split(/\r?\n/).filter(Boolean).pop() || String(result.error.message || result.error);
    console.warn(`yt-dlp: update failed (${detail})`);
    return { ok: false, version: previous, previous, changed: false, error: detail };
  }
  const version = await installedVersion(python);
  // The manual update also satisfies this release: an upgrade that just ran must not be repeated by
  // the boot path on the next restart.
  saveConfig({ ytDlpCheckedFor: appVersion() || CONFIG.ytDlpCheckedFor, ytDlpCheckedAt: Date.now() });
  console.log(`yt-dlp: ${version ? `version ${version}` : 'update finished'}`);
  return { ok: true, version, previous, changed: Boolean(version && previous && version !== previous) };
}

// `isOlder` is exported for the suite that pins the ordering: it is the rule that decides whether
// a button is offered at all, and it is worth testing on its own rather than through a spawn.
module.exports = { refreshYtDlpForAppVersion, ytDlpStatus, updateYtDlpNow, isOlder };
