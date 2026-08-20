// @ts-check
// core/ytdlpUpdate.js
// yt-dlp is the only runtime dependency that ROTS. ffmpeg, the GLSL shaders and the model weights
// keep working for years; yt-dlp's extractors are broken by the platforms themselves every few
// weeks. It is installed once, by `scripts/setup.ps1`, from the pinned `requirements-reference.txt`
// — after that nothing ever touches it, so an install left alone slowly loses the half of a
// reference board that arrives through a link, and the only cure was a full runtime repair.
//
// The refresh is anchored to the APPLICATION update rather than to a timer or to every launch:
// a build that has just replaced itself is the one moment where new code is already expected, and
// it caps the cost at one upgrade attempt per release. The version that was checked is written to
// nr.config.json, so a boot of the same build does nothing at all.
//
// The pin in `requirements-reference.txt` stays the FLOOR for a fresh install and for a repair;
// this only carries an existing venv forward between two releases. pip's default upgrade strategy
// is `only-if-needed`, so the torch/CUDA stack of the same venv is not dragged along.
// NetsuBoard runs the same policy on a different mechanism: it provisions the standalone binary and
// calls `yt-dlp -U`, which is refused on a pip install.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { CONFIG, DETECT_ENV, saveConfig } = require('./config');

// A wheel download on a metered connection must never hold the boot, and a machine behind a proxy
// that swallows the request must not hang a process either.
const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

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

/**
 * Upgrades yt-dlp once per application version. Never throws and never blocks: a failure leaves the
 * marker unwritten, so the next boot simply tries again — which is what carries the refresh over
 * for someone who was offline the day they updated.
 * @returns {Promise<{ updated: boolean, reason?: string, version?: string }>}
 */
async function refreshYtDlpForAppVersion() {
  const version = appVersion();
  if (!version) return { updated: false, reason: 'version inconnue' };
  if (CONFIG.ytDlpCheckedFor === version) return { updated: false, reason: 'déjà vérifié' };

  // A bare `python` from PATH is never used here: `venvPython()` falls back to `CONFIG.python`,
  // written by the setup, and to nothing else. An interpreter the user happens to have on their
  // PATH is not this product's environment to upgrade.
  const python = venvPython();
  if (!python) return { updated: false, reason: 'venv absent' };

  const result = await new Promise((resolve) => {
    execFile(python, ['-m', 'pip', 'install', '--upgrade', 'yt-dlp[default,curl-cffi]'],
      { timeout: UPDATE_TIMEOUT_MS, env: DETECT_ENV, windowsHide: true },
      (error, stdout, stderr) => resolve({ error, out: `${stdout || ''}${stderr || ''}`.trim() }));
  });
  if (result.error) {
    console.warn(`yt-dlp: mise à jour impossible (${String(result.error.message || result.error)})`);
    return { updated: false, reason: 'échec' };
  }
  saveConfig({ ytDlpCheckedFor: version });
  // pip prints either "Requirement already satisfied" or the version it installed; both mean the
  // venv is now current for this application version, so the marker is written in either case.
  const line = (result.out.split(/\r?\n/).filter((l) => /yt-dlp/i.test(l)).pop() || 'à jour').trim();
  console.log(`yt-dlp: ${line}`);
  return { updated: true, version };
}

module.exports = { refreshYtDlpForAppVersion };
