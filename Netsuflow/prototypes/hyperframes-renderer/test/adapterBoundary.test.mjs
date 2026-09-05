// The architectural invariant, as a test rather than a promise.
//
// HyperFrames is pre-1.0 and shipped 371 versions before it was pinned here.
// The whole reason NetsuFlow can absorb that is that exactly one module imports
// it, so an upgrade is one file's worth of work. That property is easy to state
// and easy to lose — a second import added in a hurry costs nothing today and
// everything at the next breaking release.
//
// It is also what keeps the promise of a future Remotion adapter honest: the
// abstraction is only real if nothing above it knows which engine is underneath.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const prototypeRoot = join(here, '..');

/// The only files allowed to name the engine package.
const ALLOWED = new Set([
  // The adapter itself.
  'hyperframesEngine.mjs',
  // Uses the engine's decodePng, deliberately and behind its own bounds check.
  join('pixel', 'pngToRgba.mjs').replace(/\\/g, '/'),
  // Reports which version is installed; imports nothing from it.
  'runtimeManifest.mjs',
]);

/// Directories that are not our source.
const SKIP = new Set(['node_modules', '.browser', 'reference', 'fixture', 'fixture-gsap', 'fixture-gsap-late', 'fixture-broken']);

/// Strips comments so these scans read code and not prose.
///
/// Written the third time a guard in this suite fired on its own explanatory
/// comment. A test that reports "you imported the engine" because a comment
/// says "do not import the engine" trains people to ignore it.
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
    } else if (['.mjs', '.js', '.cjs'].includes(extname(entry))) {
      yield full;
    }
  }
}

test('only the adapter boundary imports @hyperframes/engine', () => {
  const offenders = [];

  for (const file of sourceFiles(prototypeRoot)) {
    const relativePath = relative(prototypeRoot, file).replace(/\\/g, '/');
    // Tests and tools legitimately drive the engine to measure it; they are not
    // the boundary being protected.
    if (relativePath.startsWith('test/') || relativePath.startsWith('tools/')) continue;
    if (ALLOWED.has(relativePath)) continue;

    if (/@hyperframes\//.test(codeOnly(readFileSync(file, 'utf8')))) offenders.push(relativePath);
  }

  assert.deepEqual(
    offenders,
    [],
    `these files import HyperFrames outside the adapter boundary: ${offenders.join(', ')}`,
  );
});

test('nothing outside the adapter reaches into the engine internals', () => {
  // A deep import ties us to a file layout the project never promised to keep,
  // which is the failure mode H01 set out to avoid.
  const offenders = [];
  for (const file of sourceFiles(prototypeRoot)) {
    const relativePath = relative(prototypeRoot, file).replace(/\\/g, '/');
    const source = codeOnly(readFileSync(file, 'utf8'));
    if (/@hyperframes\/engine\/(?!alpha-blit|shader-transitions|package\.json)/.test(source)) {
      offenders.push(relativePath);
    }
  }
  assert.deepEqual(offenders, [], `deep engine imports: ${offenders.join(', ')}`);
});

test('the OpenFX plugin never learns which engine is underneath', () => {
  // The plugin identifier is engine-neutral on purpose and the binary must not
  // need rebuilding to gain a second engine.
  const openfxSrc = join(prototypeRoot, '..', '..', 'openfx', 'src');
  const offenders = [];
  for (const entry of readdirSync(openfxSrc)) {
    // Comments included on purpose here: the plugin must not name an engine
    // anywhere, because its visible name and description are read by users and
    // its neutrality is the reason a second engine needs no rebuild.
    const source = readFileSync(join(openfxSrc, entry), 'utf8');
    if (/hyperframes|HyperFrames|remotion|Remotion/.test(source)) offenders.push(entry);
  }
  assert.deepEqual(offenders, [], `engine names leaked into the plugin: ${offenders.join(', ')}`);
});
