// The operating system's own folder chooser.
//
// The served directory listing stays, because it is the only thing that works
// when the service and the browser are not on the same desktop. But when they
// are — which is the whole of this product today — asking Windows is better
// than reimplementing it: pinned places, network locations, typing a path,
// creating a folder, and the muscle memory that comes with all of them.
//
// pwsh is preferred over powershell.exe on measured evidence, not taste: its
// FolderBrowserDialog exposes AutoUpgradeEnabled, InitialDirectory and
// ShowPinnedPlaces, which is the modern IFileDialog chooser, while Windows
// PowerShell 5.1 exposes only Description, RootFolder and SelectedPath — the
// old tree. Both are driven by the same script.

import { spawn } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, 'tools', 'pick-folder.ps1');

/// Long enough that someone can go and look for a folder, bounded so a dialog
/// dismissed by something other than the user cannot wedge the request forever.
const DIALOG_TIMEOUT_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15 * 1000;

const HOSTS = ['pwsh', 'powershell.exe'];

function run(host, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(host, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolvePromise({ ok: false, reason: error.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ ok: false, reason: 'le dialogue ne répond pas' });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', (error) => finish({ ok: false, reason: error.message }));
    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, stdout: stdout.trim() });
        return;
      }
      finish({ ok: false, reason: stderr.trim().split('\n').slice(-2).join(' ') || `code ${code}` });
    });
  });
}

/// Which host can actually put the chooser on screen, or null when none can.
/// Probed rather than assumed, so the editor can hide the button instead of
/// offering one that fails after the click.
let cachedHost;
export async function probeNativePicker() {
  if (cachedHost !== undefined) return cachedHost;
  if (process.platform !== 'win32') {
    cachedHost = null;
    return cachedHost;
  }
  for (const host of HOSTS) {
    const result = await run(
      host,
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-SelfTest'],
      PROBE_TIMEOUT_MS,
    );
    if (result.ok && result.stdout === 'OK') {
      cachedHost = host;
      return cachedHost;
    }
  }
  cachedHost = null;
  return cachedHost;
}

/// Opens the chooser and resolves to the folder, or null when cancelled.
///
/// A cancel is not an error and must not be reported as one: the user closing a
/// dialog they opened by mistake should leave the form exactly as it was.
export async function pickFolderNatively(initial) {
  const host = await probeNativePicker();
  if (!host) throw new Error("aucun sélecteur natif disponible sur ce système");

  const result = await run(
    host,
    [
      '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
      '-Initial', typeof initial === 'string' ? initial : '',
      '-Title', 'Dossier de destination NetsuFlow',
    ],
    DIALOG_TIMEOUT_MS,
  );
  if (!result.ok) throw new Error(result.reason);
  return result.stdout === '' ? null : result.stdout;
}
