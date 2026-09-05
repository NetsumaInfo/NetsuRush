// One command between a page you wrote and a frame in Resolve.
//
//   node tools/render-in-resolve.mjs my-page.html
//   node tools/render-in-resolve.mjs my-page.html --var accent=violet
//
// Everything this does by hand is something that otherwise renders nothing
// with no error anywhere, which is a bad way to learn a contract:
//
//   * the size must equal the host's exactly, or every frame is refused;
//   * the revision must be "0", because the plugin hardcodes it;
//   * a Studio-authored page needs its template mounted and its timeline
//     bridged, or it draws an empty stage;
//   * the node must be on Bridge with a binding typed in, or it quietly
//     renders the plugin's own CPU pattern instead.
//
// So the size and fps are read from the open project, the mode is detected
// from the page, and the node is configured through Resolve's own API.

import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { HyperFramesEngine } from '../hyperframesEngine.mjs';
import { buildRuntimeManifest } from '../runtimeManifest.mjs';
import { startBridgeServer } from '../server.mjs';

const run = promisify(execFile);
const HERE = resolve(import.meta.dirname, '..');
const BINDING = 'harness';

const args = process.argv.slice(2);
const positional = args.filter((value, index) => !value.startsWith('--') && !isFlagValue(index));

function isFlagValue(index) {
  const previous = args[index - 1];
  return previous === '--var' || previous === '--python' || previous === '--session';
}

function readVars() {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--var') continue;
    const pair = args[i + 1] ?? '';
    const split = pair.indexOf('=');
    if (split <= 0) die(`--var needs id=value, got ${JSON.stringify(pair)}`);
    const raw = pair.slice(split + 1);
    try {
      out[pair.slice(0, split)] = JSON.parse(raw);
    } catch {
      out[pair.slice(0, split)] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const source = positional[0];
if (!source) die('usage: node tools/render-in-resolve.mjs <page.html or folder> [--var id=value ...]');

// A single file becomes a project of one page. A folder is used as it stands,
// so a composition with its own CSS, fonts or images keeps them.
const sourcePath = resolve(source);
let projectRoot;
let entryPoint = 'index.html';
if (statSync(sourcePath).isDirectory()) {
  projectRoot = sourcePath;
} else {
  projectRoot = join(HERE, 'paste');
  rmSync(projectRoot, { recursive: true, force: true });
  mkdirSync(projectRoot, { recursive: true });
  copyFileSync(sourcePath, join(projectRoot, entryPoint));
  process.stdout.write(`copied ${basename(sourcePath)} into paste/\n`);
}

const python = args.includes('--python')
  ? args[args.indexOf('--python') + 1]
  : join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python313', 'python.exe');

async function probe(configure) {
  const probeArgs = [join(HERE, 'tools', 'resolve-probe.py')];
  if (configure) probeArgs.push('--configure', BINDING);
  let stdout;
  try {
    ({ stdout } = await run(python, probeArgs, { maxBuffer: 1 << 20 }));
  } catch (error) {
    die(
      `could not talk to Resolve through ${python}\n` +
        `${error.stdout || ''}${error.stderr || ''}\n` +
        'Pass --python <path to a normally installed python.exe>. The Microsoft ' +
        'Store build cannot load fusionscript.dll.',
    );
  }
  const parsed = JSON.parse(stdout.trim().split('\n').pop());
  if (!parsed.ok) die(parsed.error);
  return parsed;
}

const host = await probe(false);
process.stdout.write(
  `project ${JSON.stringify(host.project)}: ${host.width}x${host.height} at ${host.fps} fps\n`,
);
if (!host.node) {
  process.stdout.write(
    'no NetsuFlow node found in the current Fusion comp — add one, then run this again\n',
  );
}

const engine = new HyperFramesEngine({
  chromePath: join(
    HERE,
    '.browser',
    'chrome-headless-shell',
    'win64-152.0.7977.54',
    'chrome-headless-shell-win64',
    'chrome-headless-shell.exe',
  ),
  enginePackageVersion: buildRuntimeManifest().engine.resolvedVersion,
});

const server = await startBridgeServer({
  engine,
  bindings: {
    [BINDING]: {
      projectRoot,
      entryPoint,
      compositionId: 'netsuflow-user',
      // What the plugin sends. Anything else is refused as stale-revision.
      sourceRevision: '0',
      width: host.width,
      height: host.height,
      fps: { num: host.fps, den: 1 },
      studioCompat: true,
      timelineMode: 'none',
      props: readVars(),
    },
  },
  sessionFile: args.includes('--session')
    ? args[args.indexOf('--session') + 1]
    : join(process.env.LOCALAPPDATA ?? '', 'NetsuRush', 'netsuflow', 'session.json'),
});

process.stdout.write(`service on 127.0.0.1:${server.port}\n`);
await server.warm(BINDING);
process.stdout.write('session warm\n');

if (host.node) {
  const after = await probe(true);
  process.stdout.write(
    `node ${after.node.name}: binding=${JSON.stringify(after.node.binding)} ` +
      `mode=${after.node.mode === 1 ? 'Bridge' : 'Local Diagnostic'}\n` +
      `status: ${after.node.status}\n`,
  );
}

process.stdout.write('\nrendering. Ctrl-C to stop.\n');
process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
