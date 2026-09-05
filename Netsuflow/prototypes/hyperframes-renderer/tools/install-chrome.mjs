// Installs the full Chrome-for-Testing build beside the pinned
// chrome-headless-shell, at the same version.
//
// Not a preference: `chrome-headless-shell.exe` is a CONSOLE-subsystem binary
// (PE subsystem 3, measured), so Windows gives every process in its tree a
// console — inherited if the parent has one, freshly allocated if not, and a
// freshly allocated console is a visible window on a machine where Windows
// Terminal is the default console host. Neither DETACHED_PROCESS nor
// CREATE_NO_WINDOW on the service fixes it: both were tried and measured, and
// an empty terminal titled `chrome-headless-shell.exe` survived each one.
//
// `chrome.exe` is subsystem 2 (GUI). Windows never allocates a console for it,
// whatever the parent does, so the whole class of bug disappears rather than
// being worked around. Same version, same rendering engine, headless mode
// requested through Puppeteer instead of through a separate binary.
//
//   node tools/install-chrome.mjs [version]

import { install, resolveBuildId, detectBrowserPlatform, Browser } from '@puppeteer/browsers';
import { join, resolve } from 'node:path';

const HERE = resolve(import.meta.dirname, '..');
const cacheDir = join(HERE, '.browser');

const requested = process.argv[2] ?? '152.0.7977.54';
const platform = detectBrowserPlatform();
if (!platform) {
  process.stderr.write('unsupported platform\n');
  process.exit(2);
}

const buildId = await resolveBuildId(Browser.CHROME, platform, requested);
process.stdout.write(`installing chrome ${buildId} for ${platform} into ${cacheDir}\n`);

const installed = await install({
  browser: Browser.CHROME,
  buildId,
  cacheDir,
  downloadProgressCallback: (downloaded, total) => {
    if (total > 0 && downloaded === total) process.stdout.write('download complete\n');
  },
});

process.stdout.write(`executablePath: ${installed.executablePath}\n`);
