// The fingerprint every H01-H03 report has to carry.
//
// Pixels out of a headless browser depend on the engine build, the Chrome
// build, the fonts installed, and the capture mode the platform allows. A
// measurement without those recorded cannot be compared against a later one, so
// this module produces them once and every report embeds the result.
//
// It never launches a browser and never throws for a missing one: a manifest
// has to be obtainable while diagnosing the very setup that is broken.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/// Packages whose exact version can change what a captured frame looks like.
const PIXEL_RELEVANT = [
  '@hyperframes/engine',
  '@hyperframes/core',
  '@hyperframes/parsers',
  'puppeteer',
  'puppeteer-core',
];

export const ADAPTER_VERSION = '0.1.0-prototype';

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function installedVersion(name) {
  try {
    const manifest = require.resolve(`${name}/package.json`);
    return readJson(manifest)?.version ?? null;
  } catch {
    return null;
  }
}

function sha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/// Which capture mode this platform will actually get.
///
/// The deterministic BeginFrame path is Linux-only: the browser manager selects
/// it only for `process.platform === "linux"` with a headless-shell binary and
/// `--enable-begin-frame-control`, and the capture source gates its BeginFrame
/// branches on the same check. NetsuFlow is Windows-first, so in practice every
/// capture goes through Puppeteer's screenshot path, and no determinism result
/// measured upstream under BeginFrame carries over. [S-HF-CAPTURE-MODE]
export function expectedCaptureMode(platform = process.platform) {
  if (platform === 'linux') {
    return {
      mode: 'beginframe',
      deterministicPathAvailable: true,
      reason: 'Linux can request BeginFrame control, subject to the headless-shell binary and launch flags.',
    };
  }
  return {
    mode: 'screenshot',
    deterministicPathAvailable: false,
    reason: `BeginFrame capture requires Linux; ${platform} always resolves to Puppeteer screenshot capture.`,
  };
}

/// Assembles the manifest. `generatedAt` is deliberately left to the caller so
/// two manifests from one run compare equal.
export function buildRuntimeManifest({ generatedAt = null } = {}) {
  const lockPath = join(here, 'package-lock.json');
  const lock = readJson(lockPath);
  const own = readJson(join(here, 'package.json'));

  const dependencies = {};
  for (const name of PIXEL_RELEVANT) {
    dependencies[name] = installedVersion(name);
  }

  const declared = own?.dependencies?.['@hyperframes/engine'] ?? null;
  const resolved = dependencies['@hyperframes/engine'];

  return {
    adapter: {
      name: 'netsuflow-hyperframes-renderer-prototype',
      version: ADAPTER_VERSION,
    },
    node: {
      version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    engine: {
      package: '@hyperframes/engine',
      declaredVersion: declared,
      resolvedVersion: resolved,
      // An exact pin is the whole point: a range would let a capture run on a
      // build no report ever named.
      pinnedExactly: declared !== null && declared === resolved,
    },
    dependencies,
    lockfile: {
      present: existsSync(lockPath),
      lockfileVersion: lock?.lockfileVersion ?? null,
      packageCount: lock?.packages ? Object.keys(lock.packages).length : null,
      sha256: sha256(lockPath),
    },
    captureMode: expectedCaptureMode(),
    // Filled in by the browser-provisioning step. Installing with
    // --ignore-scripts is deliberate, so at this stage there is nothing to
    // report and that is not a failure.
    browser: {
      provisioned: false,
      executablePath: null,
      build: null,
      note: 'Dependencies were installed with --ignore-scripts; browser provisioning is a separate verified step.',
    },
    generatedAt,
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('runtimeManifest.mjs')) {
  process.stdout.write(`${JSON.stringify(buildRuntimeManifest(), null, 2)}\n`);
}
